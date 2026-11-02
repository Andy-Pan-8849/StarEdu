import pytest
from starit_core.config import Settings


def test_defaults_match_compose(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STARIT_DATABASE_URL", raising=False)
    settings = Settings(_env_file=None)
    assert settings.database_url.endswith("@localhost:5432/starit")
    assert settings.env == "dev"


def test_environment_overrides_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STARIT_DATABASE_URL", "postgresql+psycopg://u:p@db:5432/x")
    monkeypatch.setenv("STARIT_LOG_LEVEL", "DEBUG")
    settings = Settings(_env_file=None)
    assert settings.database_url == "postgresql+psycopg://u:p@db:5432/x"
    assert settings.log_level == "DEBUG"


def test_secret_is_not_in_repr() -> None:
    assert "starit-secret" not in repr(Settings(_env_file=None))
