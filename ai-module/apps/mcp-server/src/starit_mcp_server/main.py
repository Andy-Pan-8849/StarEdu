"""The MCP server: the data tools over streamable HTTP, behind bearer-token authentication."""

import logging

import uvicorn
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.auth import TokenVerifier, jwks_key_resolver
from starit_core.config import Settings, get_settings
from starit_core.dataaccess.tools import DataTools
from starit_core.db import create_engine
from starit_core.embeddings import embedding_client
from starit_core.logging import configure_logging
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse

from starit_mcp_server.auth import JwtTokenVerifier
from starit_mcp_server.tools import register_tools


def build_app(settings: Settings, engine: AsyncEngine, verifier: TokenVerifier) -> Starlette:
    jwt_verifier = JwtTokenVerifier(verifier)
    server = MCPServer(
        "starit-data",
        token_verifier=jwt_verifier,
        auth=AuthSettings(
            issuer_url=settings.oidc_issuer,
            resource_server_url=settings.mcp_url,
            validate_token_resource=False,  # the audience is checked by TokenVerifier
        ),
    )
    register_tools(server, DataTools(engine, settings, embedding_client(settings)), jwt_verifier)

    @server.custom_route("/health", methods=["GET"])  # type: ignore[untyped-decorator]
    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok"})

    return server.streamable_http_app()


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    verifier = TokenVerifier(
        issuer=settings.oidc_issuer,
        audience=settings.oidc_audience_mcp,
        key_resolver=jwks_key_resolver(settings.oidc_jwks_url),
    )
    app = build_app(settings, create_engine(settings), verifier)
    logging.getLogger("starit_mcp_server").info("starting on port %s", settings.mcp_port)
    uvicorn.run(app, host="0.0.0.0", port=settings.mcp_port, log_level="warning")  # noqa: S104


if __name__ == "__main__":
    main()
