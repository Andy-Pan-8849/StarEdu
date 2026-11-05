"""文件：scripts/build_realm.py
作用：根据 sample-data/demo-accounts.csv 生成 Keycloak 的域配置文件
deploy/compose/keycloak/starit-realm.json（运行：uv run python scripts/build_realm.py）。
主要思想：演示账号都是示例数据里的真实一员（学员/员工），所以“自己的记录”“本校区”可以测试；
所有账号共用一个演示密码，只用于本地演示。
生成内容：七个角色；web 客户端（PKCE、密码授权仅供脚本和测试取令牌，真实部署要关掉）、
API 和 MCP 两个只接受令牌的客户端；把校区、职级、员工/学员编号作为自定义声明放进令牌；
audience 映射让同一个令牌能被 API 和 MCP 两边接受。
"""

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ACCOUNTS = ROOT / "sample-data" / "demo-accounts.csv"
OUT = ROOT / "deploy" / "compose" / "keycloak" / "starit-realm.json"
DEMO_PASSWORD = "demo-pass-123"

# 七个角色：五个业务角色加两个管理角色（后两者默认不能读受限内容）
ROLES = {
    "student": "Student of a StarIT campus",
    "staff": "Employee (instructor or staff)",
    "manager": "Campus or department manager",
    "hr": "Human Resources",
    "finance": "Finance",
    "Admin": "Manages users, roles and configuration; no default access to restricted content",
    "RAGETLAdmin": "Manages knowledge-base documents (upload, delete, re-index)",
}
# 放进令牌的自定义属性：权限判断要用
CUSTOM_ATTRIBUTES = ["campus_id", "level", "employee_id", "student_id"]


def attr_mapper(name: str) -> dict:
    """把用户属性映射成令牌里的同名声明。"""
    return {
        "name": name,
        "protocol": "openid-connect",
        "protocolMapper": "oidc-usermodel-attribute-mapper",
        "config": {
            "user.attribute": name,
            "claim.name": name,
            "jsonType.label": "String",
            "access.token.claim": "true",
            "id.token.claim": "true",
            "userinfo.token.claim": "true",
        },
    }


def aud_mapper(client_id: str) -> dict:
    """给令牌加上受众(audience)，让对应服务接受它。"""
    return {
        "name": f"audience-{client_id}",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-audience-mapper",
        "config": {
            "included.client.audience": client_id,
            "access.token.claim": "true",
            "id.token.claim": "false",
        },
    }


def profile_attribute(name: str, display: str, validations: dict | None = None) -> dict:
    """声明 Keycloak 用户资料里的一个属性及其校验与权限。"""
    return {
        "name": name,
        "displayName": display,
        "validations": validations or {},
        "permissions": {"view": ["admin", "user"], "edit": ["admin", "user"]},
    }


def main() -> None:
    """读取演示账号、拼出完整的域配置并写入文件。"""
    user_profile = {
        "attributes": [
            profile_attribute("username", "${username}", {"length": {"min": 3, "max": 255}}),
            profile_attribute("email", "${email}", {"email": {}, "length": {"max": 255}}),
            profile_attribute("firstName", "${firstName}", {"length": {"max": 255}}),
            profile_attribute("lastName", "${lastName}", {"length": {"max": 255}}),
            *[
                {
                    "name": name,
                    "displayName": name,
                    "permissions": {"view": ["admin", "user"], "edit": ["admin"]},
                }
                for name in CUSTOM_ATTRIBUTES
            ],
        ]
    }

    # 每个演示账号一个用户：姓名拆成名/姓，属性带校区、职级、编号，角色一个
    users = []
    with open(ACCOUNTS, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            first, _, last = row["name"].partition(" ")
            attributes = {"campus_id": [row["campus_id"]]}
            if row["level"]:
                attributes["level"] = [row["level"]]
            attributes["student_id" if row["subject_type"] == "student" else "employee_id"] = [
                row["subject_id"]
            ]
            users.append(
                {
                    "username": row["username"],
                    "enabled": True,
                    "emailVerified": True,
                    "email": f"{row['username']}@starit.example",
                    "firstName": first,
                    "lastName": last,
                    "attributes": attributes,
                    "credentials": [
                        {"type": "password", "value": DEMO_PASSWORD, "temporary": False}
                    ],
                    "realmRoles": [row["role"]],
                }
            )

    realm = {
        "realm": "starit",
        "displayName": "StarIT Education (demo)",
        "enabled": True,
        "sslRequired": "none",
        "registrationAllowed": False,
        "accessTokenLifespan": 900,
        "roles": {"realm": [{"name": n, "description": d} for n, d in ROLES.items()]},
        "clients": [
            {
                "clientId": "starit-web",
                "name": "StarIT web front end",
                "enabled": True,
                "publicClient": True,
                "standardFlowEnabled": True,
                # Demo realm only: lets scripts and tests fetch tokens with a password.
                # Turn this off in any real deployment.
                "directAccessGrantsEnabled": True,
                "redirectUris": ["http://localhost:3000/*"],
                "webOrigins": ["http://localhost:3000"],
                "attributes": {"pkce.code.challenge.method": "S256"},
                "protocolMappers": [
                    aud_mapper("starit-api"),
                    aud_mapper("starit-mcp"),
                    *[attr_mapper(name) for name in CUSTOM_ATTRIBUTES],
                ],
            },
            {"clientId": "starit-api", "enabled": True, "bearerOnly": True},
            {"clientId": "starit-mcp", "enabled": True, "bearerOnly": True},
        ],
        "components": {
            "org.keycloak.userprofile.UserProfileProvider": [
                {
                    "providerId": "declarative-user-profile",
                    "subComponents": {},
                    "config": {"kc.user.profile.config": [json.dumps(user_profile)]},
                }
            ]
        },
        "users": users,
    }
    OUT.write_text(json.dumps(realm, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} with {len(users)} users")


if __name__ == "__main__":
    main()
