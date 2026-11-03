"""JWT verification and the caller's identity.

Identity comes only from a verified token. Nothing a client sends in a request body is
trusted for who the caller is.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import jwt
from jwt import PyJWKClient

# The roles defined in the Keycloak realm (docs/design/01-architecture-and-repo.md, 4.3).
# Any other role in a token (Keycloak adds default ones) is ignored.
KNOWN_ROLES = frozenset({"student", "staff", "manager", "hr", "finance", "Admin", "RAGETLAdmin"})

ALLOWED_ALGORITHMS = ["RS256", "ES256"]

# Given a raw token, return the key that should verify its signature.
KeyResolver = Callable[[str], Any]


@dataclass(frozen=True)
class Identity:
    user_id: str
    username: str | None
    name: str | None
    roles: frozenset[str]
    campus_id: str | None
    level: str | None
    employee_id: str | None = None
    student_id: str | None = None


class AuthError(Exception):
    """The token is missing, malformed, expired, or otherwise not acceptable."""


class AuthUnavailableError(Exception):
    """The signing keys could not be fetched, so no token can be checked right now."""


def jwks_key_resolver(jwks_url: str) -> KeyResolver:
    """Resolve signing keys from a JWKS endpoint, with the keys cached."""
    client = PyJWKClient(jwks_url, cache_keys=True, lifespan=300)

    def resolve(token: str) -> Any:
        return client.get_signing_key_from_jwt(token).key

    return resolve


class TokenVerifier:
    def __init__(self, *, issuer: str, audience: str, key_resolver: KeyResolver) -> None:
        self._issuer = issuer
        self._audience = audience
        self._key_resolver = key_resolver

    def verify(self, token: str) -> Identity:
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
