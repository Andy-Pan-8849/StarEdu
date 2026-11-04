"""FastAPI dependencies: who is calling, and are they allowed."""

from collections.abc import Callable

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import AuthError, AuthUnavailableError, Identity, TokenVerifier
from starit_core.cost import DailyBudget
from starit_core.ratelimit import RateLimiter
from starit_core.storage import ObjectStorage

from starit_api.errors import ApiError

_bearer = HTTPBearer(auto_error=False)
_CHALLENGE = {"WWW-Authenticate": "Bearer"}


def get_engine(request: Request) -> AsyncEngine:
    engine: AsyncEngine = request.app.state.engine
    return engine


def get_runtime(request: Request) -> AgentRuntime:
    runtime: AgentRuntime = request.app.state.runtime
    return runtime


def get_storage(request: Request) -> ObjectStorage:
    storage: ObjectStorage = request.app.state.storage
    return storage


def get_budget(request: Request) -> DailyBudget | None:
    budget: DailyBudget | None = request.app.state.budget
    return budget


def get_limiter(request: Request) -> RateLimiter:
    limiter: RateLimiter = request.app.state.limiter
    return limiter


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


def get_access_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    """The caller's raw token, to be forwarded to the data service. Kept in memory only."""
    return credentials.credentials if credentials else None


def require_roles(*roles: str) -> Callable[[Identity], Identity]:
    """Allow the call only when the caller has at least one of the given roles."""
    wanted = frozenset(roles)

    def check(identity: Identity = Depends(get_identity)) -> Identity:
        if not identity.roles & wanted:
            raise ApiError(403, "forbidden", "Your role does not allow this action")
        return identity

    return check
