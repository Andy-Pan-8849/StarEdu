"""文件：main.py
作用：MCP 服务器的装配与启动。
主要思想：
  - build_app 创建 MCPServer，接上令牌校验、注册六个数据工具、加 /health 健康检查，
    开启 DNS 重绑定保护（只接受允许的 Host 头），按配置接入 OpenTelemetry。
  - OpenTelemetry 中间件会从请求头的 traceparent 接上调用方（API）的链路，
    所以一次聊天从 API 到 MCP 到数据库在 Grafana 里是同一条链路。
  - main 是进程入口：读配置、建校验器和引擎、用 uvicorn 在 mcp_port 端口提供服务。
"""

import logging

import uvicorn
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from opentelemetry.instrumentation.asgi import OpenTelemetryMiddleware
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.auth import TokenVerifier, jwks_key_resolver
from starit_core.config import Settings, get_settings
from starit_core.cost import make_budget
from starit_core.dataaccess.tools import DataTools
from starit_core.db import create_engine
from starit_core.embeddings import embedding_client
from starit_core.logging import configure_logging
from starit_core.telemetry import Providers, instrument_engine, setup_telemetry
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse

from starit_mcp_server.auth import JwtTokenVerifier
from starit_mcp_server.tools import register_tools


def build_app(
    settings: Settings,
    engine: AsyncEngine,
    verifier: TokenVerifier,
    providers: Providers | None = None,
) -> Starlette:
    """构造 MCP 服务的 ASGI 应用。

    参数：settings 配置；engine 数据库引擎；verifier 令牌校验器（受众是 MCP）；
      providers 可选的 OpenTelemetry 提供者。
    """
    jwt_verifier = JwtTokenVerifier(verifier)
    server = MCPServer(
        "starit-data",
        token_verifier=jwt_verifier,
        auth=AuthSettings(
            issuer_url=settings.oidc_issuer,
            resource_server_url=settings.mcp_url,
            # 不在这里校验资源，受众由 TokenVerifier 检查
            validate_token_resource=False,  # the audience is checked by TokenVerifier
        ),
    )
    register_tools(
        server,
        DataTools(engine, settings, embedding_client(settings, make_budget(settings))),
        jwt_verifier,
    )

    @server.custom_route("/health", methods=["GET"])  # type: ignore[untyped-decorator]
    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok"})

    # 允许的 Host 头（防 DNS 重绑定攻击）
    hosts = [h.strip() for h in settings.mcp_allowed_hosts.split(",") if h.strip()]
    app = server.streamable_http_app(
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True, allowed_hosts=hosts
        )
    )
    # 接入链路：继续调用方的 trace（W3C traceparent），不记录请求头；/health 不记录
    if providers is not None:
        # Continues the caller's trace (the W3C `traceparent` header) and records no headers.
        app.add_middleware(
            OpenTelemetryMiddleware,
            tracer_provider=providers.tracer_provider,
            meter_provider=providers.meter_provider,
            excluded_urls="health",
        )
    return app


def main() -> None:
    """进程入口：读配置 -> 建校验器/链路/引擎 -> 启动 uvicorn。"""
    settings = get_settings()
    configure_logging(settings.log_level)
    verifier = TokenVerifier(
        issuer=settings.oidc_issuer,
        audience=settings.oidc_audience_mcp,
        key_resolver=jwks_key_resolver(settings.oidc_jwks_url),
    )
    providers = setup_telemetry(settings, "starit-mcp-server")
    engine = create_engine(settings)
    instrument_engine(engine)
    app = build_app(settings, engine, verifier, providers)
    logging.getLogger("starit_mcp_server").info("starting on port %s", settings.mcp_port)
    uvicorn.run(app, host="0.0.0.0", port=settings.mcp_port, log_level="warning")  # noqa: S104


if __name__ == "__main__":
    main()
