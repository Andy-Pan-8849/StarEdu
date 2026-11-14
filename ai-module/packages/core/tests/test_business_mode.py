"""文件：测试——业务模式（B10）
测什么：多签发者令牌校验（租户域的签发者必须正好符合规则、各自取公钥、其他一律拒绝）；
身份解析器（调业务模块的内部接口、按权限版本号缓存、出错分类、角色映射）；与业务模块发布的回答格式
（contracts/internal-authz.schema.json）一致；业务身份写进数据库会话设置；业务模式下的 SQL 校验与提示；
助手在业务模式下数据问题只走 SQL 路径、在业务库的引擎上执行。独立模式的行为由原有测试保证不变。
"""

import json
import time
import uuid
from pathlib import Path
from typing import Any, cast

import httpx
import jsonschema
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from langchain_core.runnables import RunnableConfig
from starit_core.agent.nodes import AgentNodes
from starit_core.agent.state import RunContext, RunTotals
from starit_core.auth import (
    AuthError,
    AuthUnavailableError,
    BusinessAccess,
    Identity,
    MultiIssuerVerifier,
    TokenVerifier,
)
from starit_core.config import Settings
from starit_core.dataaccess.business_schema import BUSINESS_VIEWS
from starit_core.dataaccess.schema import schema_prompt
from starit_core.dataaccess.sqlguard import SqlRejected, validate_sql
from starit_core.identity import (
    BusinessAuthzClient,
    BusinessResolver,
    ClaimsResolver,
    ai_roles,
    build_identity_stack,
    parse_aliases,
)
from starit_core.sqlaccess import run_as_identity
from starit_core.testing import ScriptedChat

BASE = "http://keycloak:8080/realms"
AUDIENCE = "starit-api"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
SCHEMA = json.loads(
    (
        Path(__file__).resolve().parents[4] / "business-module/contracts/internal-authz.schema.json"
    ).read_text(encoding="utf-8")
)
TENANT_ID = str(uuid.uuid4())
PERSON_ID = str(uuid.uuid4())


def token(issuer: str, key: rsa.RSAPrivateKey = KEY, **over: Any) -> str:
    claims: dict[str, Any] = {
        "sub": "kc-user-1",
        "iss": issuer,
        "aud": [AUDIENCE],
        "exp": int(time.time()) + 300,
        "preferred_username": "teacher.one",
    }
    claims.update(over)
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm="RS256")


class FakeKeys:
    """记录每个签发者取公钥的地址；不存在真实的网络访问。"""

    def __init__(self) -> None:
        self.urls: list[str] = []

    def __call__(self, url: str) -> Any:
        self.urls.append(url)
        return lambda _token: KEY.public_key()


def verifier(keys: FakeKeys | None = None) -> MultiIssuerVerifier:
    standalone = TokenVerifier(
        issuer=f"{BASE}/starit", audience=AUDIENCE, key_resolver=lambda _t: KEY.public_key()
    )
    return MultiIssuerVerifier(
        audience=AUDIENCE,
        fixed={f"{BASE}/starit": standalone},
        tenant_issuer_base=BASE,
        tenant_jwks_base="http://internal-keycloak:8080/realms",
        resolver_factory=keys or FakeKeys(),
    )


class TestMultiIssuer:
    def test_a_tenant_realm_token_is_accepted_and_keys_come_from_that_realm_only(self) -> None:
        keys = FakeKeys()
        v = verifier(keys)
        assert v.verify_claims(token(f"{BASE}/tenant-hq"))["sub"] == "kc-user-1"
        v.verify_claims(token(f"{BASE}/tenant-riverside-franchise"))
        v.verify_claims(token(f"{BASE}/tenant-hq"))  # 第二次用缓存
        assert keys.urls == [
            "http://internal-keycloak:8080/realms/tenant-hq/protocol/openid-connect/certs",
            "http://internal-keycloak:8080/realms/tenant-riverside-franchise/protocol/openid-connect/certs",
        ]

    def test_the_standalone_realm_still_works(self) -> None:
        identity = verifier().verify(token(f"{BASE}/starit", realm_access={"roles": ["staff"]}))
        assert identity.roles == {"staff"}
        assert identity.business is None and identity.tenant_id is None

    @pytest.mark.parametrize(
        "issuer",
        [
            "http://evil.example/realms/tenant-hq",  # 别的主机
            f"{BASE}/tenant-hq/evil",  # 多一截路径
            f"{BASE}/tenant-",  # 没有租户代码
            f"{BASE}/tenant-HQ",  # 代码不合规
            f"{BASE}/tenant-hq;x",
            f"{BASE}/platform",  # 平台域不是租户域
            f"{BASE}/master",
            "http://keycloak:8080/realms/tenant-hq/../master",
        ],
    )
    def test_any_other_issuer_is_refused_without_fetching_keys(self, issuer: str) -> None:
        keys = FakeKeys()
        with pytest.raises(AuthError):
            verifier(keys).verify_claims(token(issuer))
        assert keys.urls == []

    def test_signature_audience_expiry_and_missing_issuer_are_still_checked(self) -> None:
        v = verifier()
        with pytest.raises(AuthError):
            v.verify_claims(token(f"{BASE}/tenant-hq", key=OTHER_KEY))
        with pytest.raises(AuthError):
            v.verify_claims(token(f"{BASE}/tenant-hq", aud=["somebody-else"]))
        with pytest.raises(AuthError):
            v.verify_claims(token(f"{BASE}/tenant-hq", exp=int(time.time()) - 5))
        with pytest.raises(AuthError):
            v.verify_claims(token(f"{BASE}/tenant-hq", iss=None))
        with pytest.raises(AuthError):
            v.verify_claims("not.a.jwt")
        alg_none = jwt.encode(
            {"sub": "x", "iss": f"{BASE}/tenant-hq", "aud": AUDIENCE},
            None,  # type: ignore[arg-type]
            "none",
        )
        with pytest.raises(AuthError):
            v.verify_claims(alg_none)

    def test_tenant_realms_are_off_unless_configured(self) -> None:
        plain = MultiIssuerVerifier(audience=AUDIENCE)
        with pytest.raises(AuthError):
            plain.verify_claims(token(f"{BASE}/tenant-hq"))


def answer(**over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "tenantId": TENANT_ID,
        "tenantCode": "hq",
        "accountId": str(uuid.uuid4()),
        "personId": PERSON_ID,
        "username": "teacher.one",
        "name": "Teacher One",
        "kind": "staff",
        "campusCode": "HQ",
        "roles": ["teacher"],
        "permissions": ["edu:section:list", "portal:enroll:list"],
        "scopes": {
            "edu:section:list": {
                "all": False,
                "deptIds": [],
                "classIds": [],
                "selfPersonId": PERSON_ID,
            },
        },
        "permVersion": 7,
    }
    body.update(over)
    return body


class FakeBusiness:
    """业务模块的替身：记录请求，按需要返回 200（带 ETag）、304 或错误。"""

    def __init__(self, body: dict[str, Any] | None = None) -> None:
        self.body = body or answer()
        self.requests: list[httpx.Request] = []
        self.status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status)
        etag = f'"{self.body["permVersion"]}:acc"'
        if request.headers.get("if-none-match") == etag:
            return httpx.Response(304, headers={"etag": etag})
        return httpx.Response(200, json=self.body, headers={"etag": etag})


def resolver(fake: FakeBusiness, **kw: Any) -> BusinessResolver:
    client = BusinessAuthzClient(
        url_template="http://{code}.business.test:4000",
        internal_key="s3cret",
        client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)),
    )
    return BusinessResolver(verifier(), client, campus_aliases={"HQ": "BJ"}, **kw)


class TestBusinessResolver:
    async def test_identity_comes_from_the_business_answer_not_the_token(self) -> None:
        fake = FakeBusiness()
        identity = await resolver(fake).resolve(
            token(f"{BASE}/tenant-hq", realm_access={"roles": ["hr"]})
        )
        assert identity.user_id == "kc-user-1"
        assert identity.roles == {"staff"}  # 令牌里自称的 hr 被忽略
        assert identity.campus_id == "BJ"  # 总部 HQ 对应样本里的 BJ
        assert identity.business is not None
        assert identity.business.tenant_id == TENANT_ID and identity.tenant_id == TENANT_ID
        assert identity.business.person_id == PERSON_ID and identity.business.perm_version == 7
        assert (
            json.loads(identity.business.scopes_json)["edu:section:list"]["selfPersonId"]
            == PERSON_ID
        )

    async def test_the_request_goes_to_the_tenant_with_the_token_and_the_service_key(self) -> None:
        fake = FakeBusiness()
        raw = token(f"{BASE}/tenant-riverside-franchise")
        await resolver(fake).resolve(raw)
        request = fake.requests[0]
        assert (
            str(request.url) == "http://riverside-franchise.business.test:4000/api/internal/authz"
        )
        assert request.method == "POST"
        assert request.headers["authorization"] == f"Bearer {raw}"
        assert request.headers["x-internal-key"] == "s3cret"

    async def test_a_standalone_realm_token_is_not_a_company_identity(self) -> None:
        fake = FakeBusiness()
        with pytest.raises(AuthError):
            await resolver(fake).resolve(token(f"{BASE}/starit"))
        assert fake.requests == []

    @pytest.mark.parametrize("status", [401, 403, 404])
    async def test_a_refusal_is_an_auth_error(self, status: int) -> None:
        fake = FakeBusiness()
        fake.status = status
        with pytest.raises(AuthError):
            await resolver(fake).resolve(token(f"{BASE}/tenant-hq"))

    @pytest.mark.parametrize("status", [500, 502, 503])
    async def test_a_broken_business_module_is_unavailable_not_unauthorised(
        self, status: int
    ) -> None:
        fake = FakeBusiness()
        fake.status = status
        with pytest.raises(AuthUnavailableError):
            await resolver(fake).resolve(token(f"{BASE}/tenant-hq"))

    async def test_a_network_failure_is_unavailable(self) -> None:
        def boom(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down")

        client = BusinessAuthzClient(
            url_template="http://{code}.x:1",
            internal_key="k",
            client=httpx.AsyncClient(transport=httpx.MockTransport(boom)),
        )
        with pytest.raises(AuthUnavailableError):
            await BusinessResolver(verifier(), client).resolve(token(f"{BASE}/tenant-hq"))

    async def test_a_forged_token_never_reaches_the_business_module(self) -> None:
        fake = FakeBusiness()
        with pytest.raises(AuthError):
            await resolver(fake).resolve(token(f"{BASE}/tenant-hq", key=OTHER_KEY))
        assert fake.requests == []


class TestPermissionVersionCache:
    async def test_the_second_call_sends_the_version_and_a_304_reuses_the_answer(self) -> None:
        fake = FakeBusiness()
        r = resolver(fake)
        raw = token(f"{BASE}/tenant-hq")
        first = await r.resolve(raw)
        second = await r.resolve(raw)
        assert "if-none-match" not in fake.requests[0].headers
        assert fake.requests[1].headers["if-none-match"] == '"7:acc"'
        assert second == first  # 304：沿用缓存的回答

    async def test_a_permission_change_gives_a_fresh_answer(self) -> None:
        fake = FakeBusiness()
        r = resolver(fake)
        raw = token(f"{BASE}/tenant-hq")
        await r.resolve(raw)
        fake.body = answer(
            permVersion=8,
            scopes={
                "edu:section:list": {
                    "all": True,
                    "deptIds": [],
                    "classIds": [],
                    "selfPersonId": None,
                }
            },
        )
        changed = await r.resolve(raw)
        assert changed.business is not None and changed.business.perm_version == 8
        assert json.loads(changed.business.scopes_json)["edu:section:list"]["all"] is True

    async def test_each_user_has_their_own_cache_entry(self) -> None:
        fake = FakeBusiness()
        r = resolver(fake)
        await r.resolve(token(f"{BASE}/tenant-hq", sub="u1"))
        await r.resolve(token(f"{BASE}/tenant-hq", sub="u2"))
        assert all("if-none-match" not in req.headers for req in fake.requests)


class TestRoles:
    @pytest.mark.parametrize(
        ("kind", "codes", "perms", "expected"),
        [
            ("student", [], [], {"student"}),
            ("staff", ["teacher"], [], {"staff"}),
            ("staff", ["campus-lead"], [], {"staff", "manager"}),
            ("staff", ["academic-manager"], [], {"staff", "manager"}),
            ("staff", ["hr-manager"], ["hr:person:sensitive"], {"staff", "hr"}),
            ("admin", ["tenant-admin"], [], {"Admin"}),
            ("other", [], [], set()),
        ],
    )
    def test_business_identity_maps_to_knowledge_base_roles(
        self, kind: str, codes: list[str], perms: list[str], expected: set[str]
    ) -> None:
        assert ai_roles(kind, frozenset(codes), frozenset(perms)) == expected

    def test_alias_list(self) -> None:
        assert parse_aliases("HQ:BJ, XX:YY,bad") == {"HQ": "BJ", "XX": "YY"}


class TestContract:
    """业务模块发布的回答格式（两边共用同一份 JSON Schema）。"""

    def test_a_typical_answer_matches_the_published_schema(self) -> None:
        jsonschema.validate(answer(), SCHEMA)

    def test_the_schema_refuses_extra_fields_and_missing_ones(self) -> None:
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate({**answer(), "password": "x"}, SCHEMA)
        broken = answer()
        del broken["scopes"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(broken, SCHEMA)


def business_identity(scopes: dict[str, Any] | None = None) -> Identity:
    return Identity(
        user_id="kc-user-1",
        username="teacher.one",
        name=None,
        roles=frozenset({"staff"}),
        campus_id="BJ",
        level=None,
        business=BusinessAccess(
            tenant_id=TENANT_ID,
            tenant_code="hq",
            account_id=str(uuid.uuid4()),
            person_id=PERSON_ID,
            kind="staff",
            permissions=frozenset(),
            scopes_json=json.dumps(scopes or {}),
            perm_version=1,
        ),
    )


class FakeResult:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def mappings(self) -> "FakeResult":
        return self

    def fetchmany(self, n: int) -> list[dict[str, Any]]:
        return self._rows[:n]


class FakeConn:
    """记录每条语句和参数的连接替身。"""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows or []
        self.executed: list[tuple[str, dict[str, Any]]] = []

    async def execute(self, statement: Any, params: dict[str, Any] | None = None) -> FakeResult:
        self.executed.append((str(statement), dict(params or {})))
        return FakeResult(self.rows)


class TestSessionSettings:
    async def test_a_business_identity_sets_tenant_person_and_scopes_before_switching_role(
        self,
    ) -> None:
        scopes = {
            "edu:section:list": {
                "all": False,
                "deptIds": ["d1"],
                "classIds": [],
                "selfPersonId": None,
            }
        }
        conn = FakeConn([{"section_id": "s1"}])
        rows = await run_as_identity(conn, business_identity(scopes), "SELECT 1")  # type: ignore[arg-type]
        assert rows == [{"section_id": "s1"}]
        set_configs = {p["name"]: p["value"] for s, p in conn.executed if "set_config" in s}
        assert set_configs == {
            "app.tenant_id": TENANT_ID,
            "app.person_id": PERSON_ID,
            "app.scopes": json.dumps(scopes),
        }
        statements = [s for s, _ in conn.executed]
        assert statements.index("SET LOCAL ROLE ai_sql_ro") > max(
            i for i, s in enumerate(statements) if "set_config" in s
        )

    async def test_a_standalone_identity_still_sets_the_old_settings(self) -> None:
        conn = FakeConn()
        who = Identity(
            user_id="u",
            username=None,
            name=None,
            roles=frozenset({"staff"}),
            campus_id="SH",
            level=None,
            employee_id="E1",
        )
        await run_as_identity(conn, who, "SELECT 1")  # type: ignore[arg-type]
        names = {p["name"] for s, p in conn.executed if "set_config" in s}
        assert names == {
            "app.user_id",
            "app.roles",
            "app.campus_id",
            "app.employee_id",
            "app.student_id",
        }


class TestSqlForBusinessMode:
    def test_business_views_are_allowed_and_the_sample_views_are_not(self) -> None:
        who = business_identity()
        ok = validate_sql("SELECT section_id, name FROM ai_sql.sections WHERE status = 'open'", who)
        assert ok.views == ("sections",)
        with pytest.raises(SqlRejected):
            validate_sql("SELECT * FROM ai_sql.employees", who)  # 样本视图在业务库里不存在
        with pytest.raises(SqlRejected):
            validate_sql("SELECT * FROM biz.person", who)
        with pytest.raises(SqlRejected):
            validate_sql("SELECT * FROM sections", who)
        with pytest.raises(SqlRejected):
            validate_sql("SELECT set_config('app.scopes', '{}', true)", who)  # 函数不在白名单

    def test_the_sample_campus_rule_is_not_applied_to_business_identities(self) -> None:
        # 业务模式的范围由业务库的视图按业务模块给的数据范围过滤；这里不再按"样本校区编码"早拒绝
        who = business_identity()
        assert validate_sql("SELECT * FROM ai_sql.sections WHERE campus_id = 'SH'", who).views == (
            "sections",
        )

    def test_a_standalone_identity_keeps_the_old_catalog(self) -> None:
        who = Identity(
            user_id="u",
            username=None,
            name=None,
            roles=frozenset({"staff"}),
            campus_id="SH",
            level=None,
        )
        assert validate_sql("SELECT * FROM ai_sql.employees", who).views == ("employees",)
        with pytest.raises(SqlRejected):
            validate_sql("SELECT * FROM ai_sql.sections", who)

    def test_the_prompt_lists_every_business_view_and_the_person(self) -> None:
        text = schema_prompt(business_identity())
        for name in BUSINESS_VIEWS:
            assert f"ai_sql.{name}" in text
        assert PERSON_ID in text and "uuid" in text
        assert "support_tickets" not in text  # 样本视图不出现

    def test_no_view_column_is_sensitive(self) -> None:
        columns = {c for v in BUSINESS_VIEWS.values() for c, _t, _n in v.columns}
        assert not {
            c
            for c in columns
            if any(w in c for w in ("mail", "phone", "birth", "password", "address"))
        }


class FakeEngine:
    """AsyncEngine 替身：begin() 给出一个记录语句的连接。"""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.conn = FakeConn(rows)
        self.began = 0

    def begin(self) -> "FakeEngine":
        self.began += 1
        return self

    async def __aenter__(self) -> FakeConn:
        return self.conn

    async def __aexit__(self, *_exc: object) -> None:
        return None


def context(identity: Identity, chat: ScriptedChat) -> RunnableConfig:
    ctx = RunContext(
        identity=identity,
        conversation_id=uuid.uuid4(),
        run_id=uuid.uuid4(),
        totals=RunTotals(),
        chat=chat,
        reranker=None,
    )
    return cast(RunnableConfig, {"configurable": {"ctx": ctx}})


def nodes(business: FakeEngine | None) -> tuple[AgentNodes, FakeEngine]:
    own = FakeEngine()
    n = AgentNodes(engine=own, settings=Settings(), embedder=None, business_engine=business)  # type: ignore[arg-type]
    return n, own


class TestAgentInBusinessMode:
    async def test_data_questions_skip_the_sample_tools_and_go_straight_to_sql(self) -> None:
        chat = ScriptedChat()
        n, _ = nodes(FakeEngine())
        out = await n.plan_data_access(
            {"standalone_query": "my sections"}, context(business_identity(), chat)
        )
        assert out["route"] == "run_sql" and out["plan_path"] == "sql"
        assert chat.calls == []  # 没有为"选工具"白花一次模型调用

    async def test_the_sql_runs_on_the_business_engine_not_the_ai_engine(self) -> None:
        biz = FakeEngine([{"section_id": "s1", "name": "CS101-01"}])
        chat = ScriptedChat(sql='{"sql": "SELECT section_id, name FROM ai_sql.sections"}')
        n, own = nodes(biz)
        state: Any = {"standalone_query": "my sections", "sql_attempts": 0}
        out = await n.run_sql(state, context(business_identity(), chat))
        assert out["route"] == "answer_from_data" and out["data_views"] == ["sections"]
        assert biz.began == 1 and own.began == 0
        assert any("app.tenant_id" in p.get("name", "") for _s, p in biz.conn.executed)

    async def test_without_a_business_database_it_gives_up_cleanly(self) -> None:
        chat = ScriptedChat(sql='{"sql": "SELECT name FROM ai_sql.sections"}')
        n, own = nodes(None)
        state: Any = {"standalone_query": "x", "sql_attempts": 0}
        out = await n.run_sql(state, context(business_identity(), chat))
        assert out["route"] == "end_error" and own.began == 0


class TestStack:
    def test_the_default_is_standalone_and_needs_nothing_extra(self) -> None:
        stack = build_identity_stack(Settings(), audience=AUDIENCE)
        assert stack.business is False and isinstance(stack.resolver, ClaimsResolver)

    def test_business_mode_without_its_settings_refuses_to_start(self) -> None:
        with pytest.raises(RuntimeError):
            build_identity_stack(Settings(identity_mode="business"), audience=AUDIENCE)

    def test_business_mode_with_its_settings(self) -> None:
        settings = Settings(
            identity_mode="business", oidc_tenant_issuer_base=BASE, business_internal_key="k"
        )
        stack = build_identity_stack(settings, audience=AUDIENCE)
        assert stack.business is True and isinstance(stack.resolver, BusinessResolver)
