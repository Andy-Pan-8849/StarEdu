"""文件：main.py
作用：FastAPI 应用的创建与启动：中间件、路由、健康检查、/me。
主要思想：
  - lifespan：启动时一次性创建共享对象（引擎、存储、校验器、预算、助手运行时、限流器），
    放进 app.state；退出时关闭它们。
  - create_app：注册错误处理、路由、CORS，加请求 ID 中间件（每个请求一个 ID，回写到响应头，
    也写进日志），按配置开启 OpenTelemetry。
  - /healthz 只检查数据库，供容器健康检查使用；/me 返回令牌里解析出的身份，用于调试。
"""

import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import Identity, TokenVerifier, jwks_key_resolver
from starit_core.config import Settings, get_settings
from starit_core.cost import RedisDailyBudget, make_budget
from starit_core.dataaccess.client import McpDataTools
from starit_core.dataaccess.tools import DataTools, DataToolsClient
from starit_core.db import check_database, create_engine
from starit_core.embeddings import embedding_client
from starit_core.llm import chat_client
from starit_core.logging import configure_logging, request_id_var
from starit_core.ratelimit import RedisRateLimiter
from starit_core.storage import S3Storage
from starit_core.telemetry import Providers, instrument_engine, setup_telemetry

from starit_api import conversations, documents
from starit_api.deps import get_identity
from starit_api.errors import register_error_handlers

logger = logging.getLogger("starit.api")


def data_tools(settings: Settings, engine: AsyncEngine, embedder: Any) -> DataToolsClient:
    """选择数据工具的实现：mcp 后端调用 MCP 服务器（带用户自己的令牌），local
    在本进程内执行同样的工具。
    """
    if settings.data_tools_backend == "mcp":
        return McpDataTools(settings.mcp_url)
    return DataTools(engine, settings, embedder)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """应用的生命周期：启动时创建并装配所有依赖，退出时释放连接。"""
    settings = get_settings()
    configure_logging(settings.log_level)
    engine = create_engine(settings)
    instrument_engine(engine)
    app.state.engine = engine
    app.state.storage = S3Storage(settings)
    app.state.verifier = TokenVerifier(
        issuer=settings.oidc_issuer,
        audience=settings.oidc_audience_api,
        key_resolver=jwks_key_resolver(settings.oidc_jwks_url),
    )
    budget = make_budget(settings)
    app.state.budget = budget
    embedder = embedding_client(settings, budget)
    app.state.runtime = AgentRuntime(
        engine=engine,
        settings=settings,
        embedder=embedder,
        chat=chat_client(settings),
        data_tools=data_tools(settings, engine, embedder),
        budget=budget,
    )
    limiter = RedisRateLimiter(settings.redis_url)
    app.state.limiter = limiter
    logger.info("api started (env=%s)", settings.env)
    try:
        yield
    finally:
        await limiter.close()
        if isinstance(budget, RedisDailyBudget):
            await budget.close()
        await engine.dispose()


def create_app(providers: Providers | None = None) -> FastAPI:
    """创建应用。

    参数：providers——测试时可传入内存版 OpenTelemetry 提供者；平时按配置创建（关闭时为 None）。
    """
    providers = providers or setup_telemetry(get_settings(), "starit-api")
    app = FastAPI(title="StarEdu AI API", version="0.0.0", lifespan=lifespan)
    register_error_handlers(app)
    app.include_router(conversations.router)
    app.include_router(documents.router)
    # 允许哪些网页来源调用 API（CORS）
    origins = [o.strip() for o in get_settings().cors_origins.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        expose_headers=["X-Request-Id", "Content-Disposition"],
    )

    @app.middleware("http")
    # 请求 ID：沿用客户端给的 X-Request-Id，没有就生成；日志和错误响应里都会带上
    async def request_id_middleware(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex
        token = request_id_var.set(request_id)
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-Id"] = request_id
        return response

    @app.get("/healthz")
    # 健康检查：数据库连得上才算健康（返回 503 让编排系统知道）
    async def healthz(request: Request) -> JSONResponse:
        engine: AsyncEngine = request.app.state.engine
        database_ok = await check_database(engine)
        body = {
            "status": "ok" if database_ok else "degraded",
            "checks": {"database": "ok" if database_ok else "failed"},
        }
        return JSONResponse(body, status_code=200 if database_ok else 503)

    @app.get("/me")
    async def me(identity: Identity = Depends(get_identity)) -> dict[str, object]:
        return {
            "user_id": identity.user_id,
            "name": identity.name or identity.username,
            "roles": sorted(identity.roles),
            "campus_id": identity.campus_id,
            "level": identity.level,
            "employee_id": identity.employee_id,
            "student_id": identity.student_id,
        }

    # 开启链路：请求 span 与 HTTP 指标；不记录请求头（含令牌），也不记录
    #   healthz（会被频繁轮询）
    if providers is not None:
        # Request spans and HTTP metrics. Headers (the bearer token) are not recorded; the
        # health check is left out because Compose polls it every few seconds.
        FastAPIInstrumentor.instrument_app(
            app,
            tracer_provider=providers.tracer_provider,
            meter_provider=providers.meter_provider,
            excluded_urls="healthz",
        )
    return app


app = create_app()
