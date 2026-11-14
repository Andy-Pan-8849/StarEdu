"""文件：deps.py
作用：FastAPI 依赖——取共享对象（引擎、运行时、存储、预算、限流器、令牌校验器）和“谁在调用”。
主要思想：共享对象在应用启动时(main.py 的 lifespan)放进 app.state，路由通过依赖函数取用，
所以测试里可以替换成假的。get_identity 是鉴权入口：没有令牌 401，令牌无效 401，
公钥取不到 503；require_roles 在此基础上要求至少有指定角色之一，否则 403。
"""

from collections.abc import Callable

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncEngine
from starit_core.agent.runtime import AgentRuntime
from starit_core.auth import AuthError, AuthUnavailableError, Identity, TokenVerifier
from starit_core.cost import DailyBudget
from starit_core.identity import ClaimsResolver, IdentityResolver
from starit_core.ratelimit import RateLimiter
from starit_core.storage import ObjectStorage

from starit_api.errors import ApiError

# 从 Authorization: Bearer 头取令牌；auto_error=False 让我们自己返回统一格式的 401
_bearer = HTTPBearer(auto_error=False)
# 401 响应要带的 WWW-Authenticate 头
_CHALLENGE = {"WWW-Authenticate": "Bearer"}


def get_engine(request: Request) -> AsyncEngine:
    """数据库引擎（应用账号）。"""
    engine: AsyncEngine = request.app.state.engine
    return engine


def get_runtime(request: Request) -> AgentRuntime:
    """助手运行时。"""
    runtime: AgentRuntime = request.app.state.runtime
    return runtime


def get_storage(request: Request) -> ObjectStorage:
    """对象存储。"""
    storage: ObjectStorage = request.app.state.storage
    return storage


def get_budget(request: Request) -> DailyBudget | None:
    """每日预算；关闭时为 None。"""
    budget: DailyBudget | None = request.app.state.budget
    return budget


def get_limiter(request: Request) -> RateLimiter:
    """限流器。"""
    limiter: RateLimiter = request.app.state.limiter
    return limiter


def get_verifier(request: Request) -> TokenVerifier:
    """令牌校验器。"""
    verifier: TokenVerifier = request.app.state.verifier
    return verifier


def get_resolver(
    request: Request, verifier: TokenVerifier = Depends(get_verifier)
) -> IdentityResolver:
    """身份解析器：业务模式由启动时装配（令牌 + 业务模块）；否则沿用令牌声明。
    独立模式仍然经过 get_verifier，所以测试里替换校验器的做法照旧有效。
    """
    business: IdentityResolver | None = getattr(request.app.state, "business_resolver", None)
    return business if business is not None else ClaimsResolver(verifier)


async def get_identity(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    resolver: IdentityResolver = Depends(get_resolver),
) -> Identity:
    """从请求里取出并校验令牌，返回调用者身份。
    失败：没带令牌或令牌无效 -> 401；身份服务（Keycloak 公钥、业务模块）不可用 -> 503。
    """
    if credentials is None:
        raise ApiError(401, "unauthenticated", "Missing bearer token", _CHALLENGE)
    try:
        return await resolver.resolve(credentials.credentials)
    except AuthUnavailableError as exc:
        raise ApiError(503, "internal_error", "Identity service is unavailable") from exc
    except AuthError as exc:
        raise ApiError(401, "unauthenticated", "Invalid or expired token", _CHALLENGE) from exc


def get_access_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    """调用者的原始令牌，用来转发给数据服务；只放在内存里，不记录。"""
    return credentials.credentials if credentials else None


def require_roles(*roles: str) -> Callable[[Identity], Identity]:
    """生成一个依赖：调用者至少拥有 roles 里的一个角色才放行，否则 403。"""
    wanted = frozenset(roles)

    def check(identity: Identity = Depends(get_identity)) -> Identity:
        if not identity.roles & wanted:
            raise ApiError(403, "forbidden", "Your role does not allow this action")
        return identity

    return check
