"""文件：auth.py
作用：校验 JWT 令牌，得到调用者身份（Identity）。
主要思想：身份只来自校验过的令牌，请求体里客户端自己声明的任何内容都不可信。
令牌签名用 Keycloak 公布的公钥(JWKS)校验；只认我们定义的角色，Keycloak 默认附带的其他角色一律忽略。
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import jwt
from jwt import PyJWKClient

# The roles defined in the Keycloak realm (docs/design/01-architecture-and-repo.md, 4.3).
# Any other role in a token (Keycloak adds default ones) is ignored.
# 领域角色表（见 docs/design/01 的 4.3 节）；令牌里的其他角色被忽略
KNOWN_ROLES = frozenset({"student", "staff", "manager", "hr", "finance", "Admin", "RAGETLAdmin"})

# 只允许非对称签名算法，防止“算法降级”攻击
ALLOWED_ALGORITHMS = ["RS256", "ES256"]

# Given a raw token, return the key that should verify its signature.
# 类型：给一个原始令牌，返回应该用来验签的公钥
KeyResolver = Callable[[str], Any]


@dataclass(frozen=True)
class Identity:
    """调用者是谁：用户 ID、用户名、姓名、角色集合、校区、职级，以及对应的员工/学员编号。
    不可变；权限判断（文档、数据行）都以它为依据。
    """

    user_id: str
    username: str | None
    name: str | None
    roles: frozenset[str]
    campus_id: str | None
    level: str | None
    employee_id: str | None = None
    student_id: str | None = None


class AuthError(Exception):
    """令牌缺失、格式错误、过期或不合格。对应 HTTP 401。"""


class AuthUnavailableError(Exception):
    """取不到签名公钥，此刻无法判断令牌是否有效。对应 HTTP 503，而不是 401。"""


def jwks_key_resolver(jwks_url: str) -> KeyResolver:
    """从 JWKS 地址取验签公钥，并缓存 5 分钟，避免每次请求都访问 Keycloak。"""
    client = PyJWKClient(jwks_url, cache_keys=True, lifespan=300)

    def resolve(token: str) -> Any:
        return client.get_signing_key_from_jwt(token).key

    return resolve


class TokenVerifier:
    """令牌校验器：检查签名、签发者、受众、过期时间，必须包含 exp/iss/aud/sub。"""

    def __init__(self, *, issuer: str, audience: str, key_resolver: KeyResolver) -> None:
        self._issuer = issuer
        self._audience = audience
        self._key_resolver = key_resolver

    def verify(self, token: str) -> Identity:
        """校验令牌并返回 Identity。

        参数：token——原始 JWT 字符串。
        异常：令牌不合格抛 AuthError；取不到公钥抛 AuthUnavailableError。
        """
        try:
            key = self._key_resolver(token)
            claims = jwt.decode(
                token,
                key,
                algorithms=ALLOWED_ALGORITHMS,
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
        except jwt.PyJWKClientConnectionError as exc:
            raise AuthUnavailableError(str(exc)) from exc
        except jwt.PyJWTError as exc:
            raise AuthError(str(exc) or exc.__class__.__name__) from exc
        return _identity_from_claims(claims)


def _identity_from_claims(claims: dict[str, Any]) -> Identity:
    """把令牌里的声明(claims)转成 Identity；校区、职级、员工/学员编号是我们自己加的自定义声明。"""
    realm_roles = claims.get("realm_access", {}).get("roles", [])
    roles = frozenset(r for r in realm_roles if r in KNOWN_ROLES)
    return Identity(
        user_id=str(claims["sub"]),
        username=_optional_str(claims.get("preferred_username")),
        name=_optional_str(claims.get("name")),
        roles=roles,
        campus_id=_optional_str(claims.get("campus_id")),
        level=_optional_str(claims.get("level")),
        employee_id=_optional_str(claims.get("employee_id")),
        student_id=_optional_str(claims.get("student_id")),
    )


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
