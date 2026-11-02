"""FastAPI application: request ids, health check."""

import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.config import get_settings
from starit_core.db import check_database, create_engine
from starit_core.logging import configure_logging, request_id_var

logger = logging.getLogger("starit.api")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    engine = create_engine(settings)
    app.state.engine = engine
    logger.info("api started (env=%s)", settings.env)
    try:
        yield
    finally:
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="StarEdu AI API", version="0.0.0", lifespan=lifespan)

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

    return app


app = create_app()
