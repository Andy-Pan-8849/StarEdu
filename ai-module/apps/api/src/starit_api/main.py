"""FastAPI application: request ids, health check."""

import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import Identity, TokenVerifier, jwks_key_resolver
from starit_core.config import Settings, get_settings
from starit_core.dataaccess.client import McpDataTools
from starit_core.dataaccess.tools import DataTools, DataToolsClient
from starit_core.db import check_database, create_engine
from starit_core.embeddings import embedding_client
from starit_core.llm import LiteLLMChatClient
from starit_core.logging import configure_logging, request_id_var
from starit_core.ratelimit import RedisRateLimiter

from starit_api import conversations
from starit_api.deps import get_identity
from starit_api.errors import register_error_handlers

logger = logging.getLogger("starit.api")


def data_tools(settings: Settings, engine: AsyncEngine, embedder: Any) -> DataToolsClient:
    """Production calls the MCP server with the user's own token; "local" runs the same tools
    in this process (single-container setups, tests)."""
    if settings.data_tools_backend == "mcp":
        return McpDataTools(settings.mcp_url)
    return DataTools(engine, settings, embedder)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    engine = create_engine(settings)
    app.state.engine = engine
    app.state.verifier = TokenVerifier(
        issuer=settings.oidc_issuer,
        audience=settings.oidc_audience_api,
        key_resolver=jwks_key_resolver(settings.oidc_jwks_url),
    )
    embedder = embedding_client(settings)
    app.state.runtime = AgentRuntime(
        engine=engine,
        settings=settings,
        embedder=embedder,
        chat=LiteLLMChatClient(),
        data_tools=data_tools(settings, engine, embedder),
    )
    limiter = RedisRateLimiter(settings.redis_url)
    app.state.limiter = limiter
    logger.info("api started (env=%s)", settings.env)
    try:
        yield
    finally:
        await limiter.close()
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="StarEdu AI API", version="0.0.0", lifespan=lifespan)
    register_error_handlers(app)
    app.include_router(conversations.router)

    @app.middleware("http")
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

    return app


app = create_app()
