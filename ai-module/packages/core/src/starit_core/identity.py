"""文件：identity.py
作用：身份解析器——把一个令牌变成助手用的 Identity。两种实现，同一个接口：
  - 独立模式（ClaimsResolver）：沿用令牌里的声明（角色、校区、职级、员工/学员编号）。
    AI 模块单独演示和现有测试都走它，行为不变。
  - 业务模式（BusinessResolver）：令牌只证明"你是谁"（签发者 = 某个租户的域）；
    角色、权限和按权限字符划分的数据范围，向业务模块的内部接口问。
    规则只在业务模块里实现一份，权限一改立即生效；按权限版本号缓存（ETag），没变就不重新传输。
业务模式下 Identity.roles 是从业务身份映射来的知识库角色（student / staff / manager / hr / Admin），
只用于现有的文档权限判断；知识库权限与文档库对齐是 B12 的事，在此之前是过渡映射。
"""

import json
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from starit_core.auth import (
    AuthError,
    AuthUnavailableError,
    BusinessAccess,
    Identity,
    MultiIssuerVerifier,
    TokenVerifier,
    jwks_key_resolver,
)
from starit_core.config import Settings

log = logging.getLogger("starit.identity")


class IdentityResolver(Protocol):
    """给一个原始令牌，返回调用者的 Identity。
    令牌无效抛 AuthError；身份服务不可用抛 AuthUnavailableError。
    """

    async def resolve(self, token: str) -> Identity: ...


class ClaimsResolver:
    """独立模式：身份就是令牌里的声明。"""

    def __init__(self, verifier: TokenVerifier | MultiIssuerVerifier) -> None:
        self._verifier = verifier

    async def resolve(self, token: str) -> Identity:
        return self._verifier.verify(token)


def ai_roles(kind: str, role_codes: frozenset[str], permissions: frozenset[str]) -> frozenset[str]:
    """业务身份 -> AI 知识库角色（过渡映射，B12 会让知识库权限直接用业务模块的授权）。
    学生 -> student；教职员工 -> staff，人事（能看敏感信息）再加 hr，教务/校区负责人再加 manager；
    内置管理员 -> Admin（只管系统，不读业务内容）。
    """
    if kind == "student":
        return frozenset({"student"})
    if kind == "admin":
        return frozenset({"Admin"})
    if kind != "staff":
        return frozenset()
    roles = {"staff"}
    if "hr:person:sensitive" in permissions:
        roles.add("hr")
    if role_codes & {"campus-lead", "academic-manager"}:
        roles.add("manager")
    return frozenset(roles)


class BusinessAuthzClient:
    """调业务模块的内部权限接口：带用户令牌（证明身份）和服务密钥（证明是我们）。"""

    def __init__(
        self,
        *,
        url_template: str,
        internal_key: str,
        timeout: float = 5.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._template = url_template
        self._key = internal_key
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def fetch(
        self, tenant_code: str, token: str, etag: str | None
    ) -> tuple[dict[str, Any] | None, str | None]:
        """返回（回答, ETag）；回答为 None 表示"没变"（304），沿用缓存。"""
        url = self._template.replace("{code}", tenant_code).rstrip("/") + "/api/internal/authz"
        headers = {"Authorization": f"Bearer {token}", "X-Internal-Key": self._key}
        if etag:
            headers["If-None-Match"] = etag
        try:
            response = await self._client.post(url, headers=headers)
        except httpx.HTTPError as exc:
            raise AuthUnavailableError(f"business module unreachable: {exc}") from exc
        if response.status_code == 304:
            return None, etag
        if response.status_code in (401, 403, 404):
            raise AuthError(f"the business module refused the identity ({response.status_code})")
        if response.status_code != 200:
            raise AuthUnavailableError(f"business module answered {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise AuthUnavailableError("business module sent an unreadable answer") from exc
        return body, response.headers.get("etag")

    async def aclose(self) -> None:
        await self._client.aclose()


class BusinessResolver:
    """业务模式：令牌（多签发者校验）+ 业务模块的回答 -> Identity。"""

    def __init__(
        self,
        verifier: MultiIssuerVerifier,
        client: BusinessAuthzClient,
        *,
        campus_aliases: Mapping[str, str] | None = None,
        cache_seconds: float = 300.0,
        cache_size: int = 2000,
    ) -> None:
        self._verifier = verifier
        self._client = client
        self._aliases = {k.upper(): v.upper() for k, v in (campus_aliases or {}).items()}
        self._ttl = cache_seconds
        self._size = cache_size
        # (租户代码, 令牌主体) -> (ETag, 回答, 取得时间)
        self._cache: dict[tuple[str, str], tuple[str | None, dict[str, Any], float]] = {}

    async def resolve(self, token: str) -> Identity:
        claims = self._verifier.verify_claims(token)
        issuer = str(claims["iss"])
        code = self._verifier.tenant_code(issuer)
        if code is None:
            raise AuthError("this token is not from a company realm")
        key = (code, str(claims["sub"]))
        cached = self._cache.get(key)
        etag = cached[0] if cached else None
        body, new_etag = await self._client.fetch(code, token, etag)
        if body is None and cached:
            body = cached[1]
        if body is None:
            raise AuthUnavailableError("the business module sent no answer")
        if len(self._cache) >= self._size:
            self._cache.pop(next(iter(self._cache)))
        self._cache[key] = (new_etag, body, time.monotonic())
        return self._identity(claims, body)

    def _identity(self, claims: Mapping[str, Any], body: Mapping[str, Any]) -> Identity:
        kind = str(body.get("kind", "other"))
        permissions = frozenset(str(p) for p in body.get("permissions", []))
        role_codes = frozenset(str(r) for r in body.get("roles", []))
        campus = body.get("campusCode")
        campus_id = self._aliases.get(str(campus).upper(), str(campus).upper()) if campus else None
        access = BusinessAccess(
            tenant_id=str(body["tenantId"]),
            tenant_code=str(body.get("tenantCode", "")),
            account_id=str(body["accountId"]),
            person_id=str(body["personId"]) if body.get("personId") else None,
            kind=kind,
            permissions=permissions,
            scopes_json=json.dumps(body.get("scopes", {}), separators=(",", ":"), sort_keys=True),
            perm_version=int(body.get("permVersion", 0)),
        )
        return Identity(
            user_id=str(claims["sub"]),
            username=str(body.get("username")) if body.get("username") else None,
            name=str(body["name"]) if body.get("name") else None,
            roles=ai_roles(kind, role_codes, permissions),
            campus_id=campus_id,
            level=None,
            business=access,
        )


@dataclass
class IdentityStack:
    """启动时装配好的身份相关对象：解析器、业务模式标志，以及要关闭的 HTTP 客户端。"""

    resolver: IdentityResolver
    business: bool
    _client: BusinessAuthzClient | None = None

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()


def parse_aliases(text: str) -> dict[str, str]:
    """ "HQ:BJ,XX:YY" -> {"HQ": "BJ", "XX": "YY"}。"""
    pairs = (item.split(":", 1) for item in text.split(",") if ":" in item)
    return {a.strip(): b.strip() for a, b in pairs if a.strip() and b.strip()}


def build_identity_stack(settings: Settings, *, audience: str) -> IdentityStack:
    """按配置装配身份解析：令牌校验器（固定的 starit 域 + 可选的租户域）和解析器。

    独立模式（默认）：解析器就是令牌声明，行为和以前完全一样。
    业务模式：必须配了租户域的签发者地址和业务模块的服务密钥，否则启动失败（不静默退回独立模式）。
    """
    fixed = {
        settings.oidc_issuer: TokenVerifier(
            issuer=settings.oidc_issuer,
            audience=audience,
            key_resolver=jwks_key_resolver(settings.oidc_jwks_url),
        )
    }
    verifier = MultiIssuerVerifier(
        audience=audience,
        fixed=fixed,
        tenant_issuer_base=settings.oidc_tenant_issuer_base or None,
        tenant_realm_prefix=settings.oidc_tenant_realm_prefix,
        tenant_jwks_base=settings.oidc_tenant_jwks_base or None,
    )
    if settings.identity_mode != "business":
        return IdentityStack(ClaimsResolver(verifier), business=False)
    if not settings.oidc_tenant_issuer_base or not settings.business_internal_key:
        raise RuntimeError(
            "IDENTITY_MODE=business needs OIDC_TENANT_ISSUER_BASE and BUSINESS_INTERNAL_KEY"
        )
    client = BusinessAuthzClient(
        url_template=settings.business_api_url, internal_key=settings.business_internal_key
    )
    resolver = BusinessResolver(
        verifier, client, campus_aliases=parse_aliases(settings.business_campus_aliases)
    )
    return IdentityStack(resolver, business=True, _client=client)
