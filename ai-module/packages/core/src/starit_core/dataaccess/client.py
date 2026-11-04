"""Call the data tools on the MCP server, forwarding the caller's own token.

The server verifies the token itself and works out who is asking, so nothing here says who the
caller is. The token lives only in the arguments of one call: it is not stored or logged.
"""

import json
from typing import Any

import httpx2
from mcp.client import Client
from mcp.client.streamable_http import streamable_http_client
from opentelemetry import propagate

from starit_core import telemetry
from starit_core.auth import Identity

CALL_TIMEOUT_S = 30.0


class McpDataTools:
    """Same interface as `DataTools`, over HTTP. `token_for` gives the raw JWT of a caller."""

    def __init__(self, url: str, token_for: Any = None) -> None:
        self._url = url
        self._token_for = token_for

    async def call(
        self,
        identity: Identity,
        name: str,
        arguments: dict[str, Any],
        *,
        token: str | None = None,
    ) -> dict[str, Any]:
        token = token or (self._token_for(identity) if self._token_for else None)
        if not token:
            return _error("forbidden", "No token to present to the data service.")
        with telemetry.span("mcp.client.call", {"tool": name}) as active:
            # The trace continues in the MCP server: the W3C `traceparent` header carries it.
            # The token is a header of the HTTP client only; it is not in any attribute.
            headers = {"Authorization": f"Bearer {token}"}
            propagate.inject(headers)
            http = httpx2.AsyncClient(headers=headers, timeout=CALL_TIMEOUT_S)
            try:
                async with http:
                    transport = streamable_http_client(self._url, http_client=http)
                    async with Client(transport, read_timeout_seconds=CALL_TIMEOUT_S) as client:
                        result = await client.call_tool(name, arguments)
            except Exception as exc:
                telemetry.fail(active, type(exc).__name__)
                return _error(
                    "internal_error", f"The data service is unavailable ({type(exc).__name__})."
                )
        for block in result.content:
            text = getattr(block, "text", None)
            if text:
                try:
                    parsed = json.loads(text)
                except ValueError:
                    break
                if isinstance(parsed, dict) and "ok" in parsed:
                    return parsed
        return _error("internal_error", "The data service gave an unreadable answer.")


def _error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}
