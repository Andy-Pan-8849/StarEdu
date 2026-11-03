"""Bearer-token check for the MCP server: the same verifier as the API, with the MCP audience."""

import asyncio

from mcp.server.auth.provider import AccessToken
from starit_core.auth import AuthError, AuthUnavailableError, Identity, TokenVerifier


class JwtTokenVerifier:
    """Plugs `TokenVerifier` into the MCP SDK. The raw token stays in the AccessToken, so a tool
    can verify it again into an `Identity`; nothing here logs it."""

    def __init__(self, verifier: TokenVerifier) -> None:
        self._verifier = verifier

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            identity = await asyncio.to_thread(self._verifier.verify, token)
        except (AuthError, AuthUnavailableError):
            return None
        return AccessToken(
            token=token, client_id=identity.user_id, scopes=[], subject=identity.user_id
        )

    def identity(self, token: str) -> Identity:
        return self._verifier.verify(token)
