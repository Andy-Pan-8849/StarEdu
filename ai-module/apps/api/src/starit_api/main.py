"""FastAPI application: request ids, health check."""

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
    instrument_engine(engine)
    app.state.engine = engine
    app.state.storage = S3Storage(settings)
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
        chat=chat_client(settings),
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


def create_app(providers: Providers | None = None) -> FastAPI:
    """`providers` lets a test pass in-memory OpenTelemetry providers; normally they come from the
    settings (STARIT_OTEL_ENABLED) and are None when telemetry is off."""
    providers = providers or setup_telemetry(get_settings(), "starit-api")
    app = FastAPI(title="StarEdu AI API", version="0.0.0", lifespan=lifespan)
    register_error_handlers(app)
    app.include_router(conversations.router)
    app.include_router(documents.router)
    origins = [o.strip() for o in get_settings().cors_origins.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        expose_headers=["X-Request-Id", "Content-Disposition"],
    )

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
