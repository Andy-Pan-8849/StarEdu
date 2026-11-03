"""Generate deploy/compose/keycloak/starit-realm.json from sample-data/demo-accounts.csv.

Run: uv run python scripts/build_realm.py
The accounts are real people in the sample data, so "own records" and "own campus" can be
tested. All accounts share one demo password and exist for local demos only.
"""

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ACCOUNTS = ROOT / "sample-data" / "demo-accounts.csv"
OUT = ROOT / "deploy" / "compose" / "keycloak" / "starit-realm.json"
DEMO_PASSWORD = "demo-pass-123"

ROLES = {
    "student": "Student of a StarIT campus",
    "staff": "Employee (instructor or staff)",
    "manager": "Campus or department manager",
    "hr": "Human Resources",
    "finance": "Finance",
    "Admin": "Manages users, roles and configuration; no default access to restricted content",
    "RAGETLAdmin": "Manages knowledge-base documents (upload, delete, re-index)",
}
CUSTOM_ATTRIBUTES = ["campus_id", "level", "employee_id", "student_id"]


def attr_mapper(name: str) -> dict:
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
    return {
        "name": name,
        "displayName": display,
        "validations": validations or {},
        "permissions": {"view": ["admin", "user"], "edit": ["admin", "user"]},
    }


def main() -> None:
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
