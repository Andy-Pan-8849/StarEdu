import base64
import json
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from starit_core.auth import AuthError, TokenVerifier

ISSUER = "http://localhost:8080/realms/starit"
AUDIENCE = "starit-api"


def make_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


KEY = make_key()
OTHER_KEY = make_key()


def claims(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "sub": "user-1",
        "iss": ISSUER,
        "aud": [AUDIENCE, "starit-mcp"],
        "exp": int(time.time()) + 300,
        "preferred_username": "staff.sh",
        "name": "Staff Shanghai",
        "realm_access": {"roles": ["staff", "offline_access", "default-roles-starit"]},
        "campus_id": "SH",
        "level": "I2",
    }
    base.update(overrides)
    return {k: v for k, v in base.items() if v is not None}


def sign(payload: dict[str, Any], key: rsa.RSAPrivateKey = KEY) -> str:
    return jwt.encode(payload, key, algorithm="RS256")


@pytest.fixture
def verifier() -> TokenVerifier:
    return TokenVerifier(
        issuer=ISSUER, audience=AUDIENCE, key_resolver=lambda _token: KEY.public_key()
    )


def test_valid_token_gives_identity(verifier: TokenVerifier) -> None:
    identity = verifier.verify(sign(claims()))
    assert identity.user_id == "user-1"
    assert identity.username == "staff.sh"
    assert identity.roles == {"staff"}  # default Keycloak roles are dropped
    assert identity.campus_id == "SH"
    assert identity.level == "I2"


def test_unknown_roles_are_ignored_and_no_roles_is_allowed(verifier: TokenVerifier) -> None:
    token = sign(claims(realm_access={"roles": ["superuser", "hr"]}))
    assert verifier.verify(token).roles == {"hr"}
    assert verifier.verify(sign(claims(realm_access=None))).roles == frozenset()


def test_optional_attributes_may_be_missing(verifier: TokenVerifier) -> None:
    identity = verifier.verify(sign(claims(campus_id=None, level=None)))
    assert identity.campus_id is None
    assert identity.level is None


def test_expired_token_is_rejected(verifier: TokenVerifier) -> None:
    with pytest.raises(AuthError):
        verifier.verify(sign(claims(exp=int(time.time()) - 10)))


def test_wrong_issuer_is_rejected(verifier: TokenVerifier) -> None:
    with pytest.raises(AuthError):
        verifier.verify(sign(claims(iss="http://evil.example/realms/starit")))


def test_wrong_audience_is_rejected(verifier: TokenVerifier) -> None:
    with pytest.raises(AuthError):
        verifier.verify(sign(claims(aud="some-other-api")))


def test_missing_subject_is_rejected(verifier: TokenVerifier) -> None:
    with pytest.raises(AuthError):
        verifier.verify(sign(claims(sub=None)))


def test_signature_from_another_key_is_rejected(verifier: TokenVerifier) -> None:
    with pytest.raises(AuthError):
        verifier.verify(sign(claims(), key=OTHER_KEY))


def test_tampered_payload_is_rejected(verifier: TokenVerifier) -> None:
    header, _payload, signature = sign(claims()).split(".")
    forged = claims(realm_access={"roles": ["hr"]})
    body = base64.urlsafe_b64encode(json.dumps(forged).encode()).rstrip(b"=").decode()
    with pytest.raises(AuthError):
        verifier.verify(f"{header}.{body}.{signature}")


def test_unsigned_alg_none_token_is_rejected(verifier: TokenVerifier) -> None:
    def b64(data: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

    token = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims())}."
    with pytest.raises(AuthError):
        verifier.verify(token)


def test_hmac_token_signed_with_public_key_is_rejected() -> None:
    """Algorithm-confusion attack: HS256 using the public key as the secret."""
    secret = b"public-key-bytes-used-as-hmac-secret"
    verifier = TokenVerifier(issuer=ISSUER, audience=AUDIENCE, key_resolver=lambda _t: secret)
    token = jwt.encode(claims(), secret, algorithm="HS256")
    with pytest.raises(AuthError):
        verifier.verify(token)


@pytest.mark.parametrize("garbage", ["", "not-a-jwt", "a.b.c"])
def test_garbage_is_rejected(verifier: TokenVerifier, garbage: str) -> None:
    with pytest.raises(AuthError):
        verifier.verify(garbage)
