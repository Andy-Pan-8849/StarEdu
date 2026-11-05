"""文件：dataaccess/client.py
作用：通过 MCP 协议调用 MCP 服务器上的数据工具的客户端。
主要思想：把调用者自己的令牌原样转发过去，由服务器自己校验、自己判断“是谁在问”，
客户端这里不声明任何身份。令牌只存在于一次调用的参数里，不存储、不写日志、不放进链路属性。
链路上下文通过 W3C traceparent 头带过去，所以链路在 MCP 服务器里能接上。
"""

import json
from typing import Any

import httpx2
from mcp.client import Client
from mcp.client.streamable_http import streamable_http_client
from opentelemetry import propagate

from starit_core import telemetry
from starit_core.auth import Identity

# 一次工具调用的超时（秒）
CALL_TIMEOUT_S = 30.0


class McpDataTools:
    """与进程内的 `DataTools` 同一个接口，但走 HTTP。token_for 可按身份取原始令牌（测试用）。"""

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
        """调用名为 name 的工具。

        参数：identity 调用者（用于取令牌）；name 工具名；arguments 工具参数；token
          调用者的原始 JWT。
        返回：统一格式的字典：成功 {"ok": True, ...数据}，失败 {"ok": False, "error": {code,
          message}}。
        没有令牌、服务不可达、返回无法解析，都转成失败字典而不是抛异常。
        """
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
        # 工具的结果在文本块里，是一个 JSON 对象；找到带 ok 字段的那个返回
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
    """构造统一格式的失败字典。"""
    return {"ok": False, "error": {"code": code, "message": message}}
