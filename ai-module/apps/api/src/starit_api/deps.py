"""FastAPI dependencies: who is calling, and are they allowed."""

from collections.abc import Callable

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starit_core.auth import AuthError, AuthUnavailableError, Identity, TokenVerifier

from starit_api.errors import ApiError

_bearer = HTTPBearer(auto_error=False)
_CHALLENGE = {"WWW-Authenticate": "Bearer"}


def get_verifier(request: Request) -> TokenVerifier:
    verifier: TokenVerifier = request.app.state.verifier
    return verifier


def get_identity(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    verifier: TokenVerifier = Depends(get_verifier),
) -> Identity:
    if credentials is None:
        raise ApiError(401, "unauthenticated", "Missing bearer token", _CHALLENGE)
    try:
        return verifier.verify(credentials.credentials)
    except AuthUnavailableError as exc:
        raise ApiError(503, "internal_error", "Identity service is unavailable") from exc
    except AuthError as exc:
        raise ApiError(401, "unauthenticated", "Invalid or expired token", _CHALLENGE) from exc


def require_roles(*roles: str) -> Callable[[Identity], Identity]:
    """Allow the call only when the caller has at least one of the given roles."""
    wanted = frozenset(roles)

    def check(identity: Identity = Depends(get_identity)) -> Identity:
        if not identity.roles & wanted:
            raise ApiError(403, "forbidden", "Your role does not allow this action")
        return identity

    return check
