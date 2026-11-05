"""文件：auth.py
作用：MCP 服务器的令牌校验——复用 API 同一个 TokenVerifier，只是受众(audience)换成 MCP 专用的。
主要思想：令牌原文保留在 AccessToken 里，工具处理时再校验一次得到 Identity，
所以“是谁在问”完全由令牌决定，不信任任何调用方自己声明的身份。这里不记录令牌。
"""

import asyncio

from mcp.server.auth.provider import AccessToken
from starit_core.auth import AuthError, AuthUnavailableError, Identity, TokenVerifier


class JwtTokenVerifier:
    """把 TokenVerifier 接到 MCP SDK 上，实现 SDK 要求的 verify_token。"""

    def __init__(self, verifier: TokenVerifier) -> None:
        self._verifier = verifier

    async def verify_token(self, token: str) -> AccessToken | None:
        """校验令牌（放到线程里跑，因为取公钥是同步的）；无效或取不到公钥都返回 None，SDK 会据此回
        401。
        """
        try:
            identity = await asyncio.to_thread(self._verifier.verify, token)
        except (AuthError, AuthUnavailableError):
            return None
        return AccessToken(
            token=token, client_id=identity.user_id, scopes=[], subject=identity.user_id
        )

    def identity(self, token: str) -> Identity:
        """把令牌原文再校验一次，得到调用者 Identity（供工具使用）。"""
        return self._verifier.verify(token)
