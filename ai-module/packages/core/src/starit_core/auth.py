"""文件：auth.py
作用：校验 JWT 令牌，得到调用者身份（Identity）。
主要思想：身份只来自校验过的令牌，请求体里客户端自己声明的任何内容都不可信。
令牌签名用 Keycloak 公布的公钥(JWKS)校验；只认我们定义的角色，Keycloak 默认附带的其他角色一律忽略。
"""

import re
from collections import OrderedDict
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
class BusinessAccess:
    """业务模式下调用者的业务身份：来自业务模块内部权限接口的回答，不是令牌里的声明。
    scopes_json 是"每个权限字符下的数据范围"（JSON 文本），原样写进数据库会话设置 app.scopes，
    ai_sql 视图据此过滤行；规则只在业务模块里实现一份。
    """

    tenant_id: str
    tenant_code: str
    account_id: str
    person_id: str | None
    kind: str
    permissions: frozenset[str]
    scopes_json: str
    perm_version: int


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
    # 业务模式才有；独立模式为 None（现有行为不变）
    business: BusinessAccess | None = None

    @property
    def tenant_id(self) -> str | None:
        """业务模式下所属租户；独立模式为 None。"""
        return self.business.tenant_id if self.business else None


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
        return _identity_from_claims(self.verify_claims(token))

    def verify_claims(self, token: str) -> dict[str, Any]:
        """校验令牌，返回校验过的声明（身份解析器要用）。异常同 verify。"""
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
        return dict(claims)


# 租户域名：tenant-<租户代码>；代码和业务模块的规则一致（小写字母开头，字母数字和连字符）
_TENANT_CODE = re.compile(r"^[a-z][a-z0-9-]{1,30}$")


class MultiIssuerVerifier:
    """多签发者令牌校验器：固定的签发者（如独立模式的 starit 域）加上"每个租户一个域"的签发者。

    租户域的签发者必须正好是 <基础地址>/<前缀><租户代码>（不能多一截路径、不能换主机），所以令牌里的
    iss 不能把我们引到任意地址去取公钥；每个签发者各有自己的公钥缓存。签名、受众、过期照常校验。
    """

    def __init__(
        self,
        *,
        audience: str,
        fixed: dict[str, TokenVerifier] | None = None,
        tenant_issuer_base: str | None = None,
        tenant_realm_prefix: str = "tenant-",
        tenant_jwks_base: str | None = None,
        resolver_factory: Callable[[str], KeyResolver] = jwks_key_resolver,
        max_tenants: int = 500,
    ) -> None:
        self._audience = audience
        self._fixed = dict(fixed or {})
        self._base = tenant_issuer_base.rstrip("/") if tenant_issuer_base else None
        self._prefix = tenant_realm_prefix
        self._jwks_base = (tenant_jwks_base or tenant_issuer_base or "").rstrip("/")
        self._factory = resolver_factory
        self._tenants: OrderedDict[str, TokenVerifier] = OrderedDict()
        self._max = max_tenants

    def tenant_code(self, issuer: str) -> str | None:
        """这个签发者是租户域吗？是就返回租户代码，否则 None。"""
        if not self._base or not issuer.startswith(f"{self._base}/{self._prefix}"):
            return None
        code = issuer[len(self._base) + 1 + len(self._prefix) :]
        return code if _TENANT_CODE.match(code) else None

    def _verifier_for(self, issuer: str) -> TokenVerifier:
        if issuer in self._fixed:
            return self._fixed[issuer]
        code = self.tenant_code(issuer)
        if code is None:
            raise AuthError("issuer is not allowed")
        cached = self._tenants.get(issuer)
        if cached is not None:
            self._tenants.move_to_end(issuer)
            return cached
        jwks = f"{self._jwks_base}/{self._prefix}{code}/protocol/openid-connect/certs"
        verifier = TokenVerifier(
            issuer=issuer, audience=self._audience, key_resolver=self._factory(jwks)
        )
        self._tenants[issuer] = verifier
        if len(self._tenants) > self._max:
            self._tenants.popitem(last=False)
        return verifier

    def verify_claims(self, token: str) -> dict[str, Any]:
        """先读出（尚未信任的）签发者，确认它在允许范围内，再用它自己的公钥完整校验。"""
        try:
            unverified = jwt.decode(token, options={"verify_signature": False})
        except jwt.PyJWTError as exc:
            raise AuthError(str(exc) or exc.__class__.__name__) from exc
        issuer = unverified.get("iss")
        if not isinstance(issuer, str):
            raise AuthError("token has no issuer")
        return self._verifier_for(issuer).verify_claims(token)

    def verify(self, token: str) -> Identity:
        return _identity_from_claims(self.verify_claims(token))


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
