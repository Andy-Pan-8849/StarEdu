"""Application settings, read from environment variables (prefix STARIT_)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="STARIT_", env_file=".env", extra="ignore")

    env: str = "dev"
    log_level: str = "INFO"

    # Defaults match deploy/compose/compose.yaml so a local run works without configuration.
    # The application connects as the ordinary role ai_app; only migrations use the owner.
    database_url: str = "postgresql+psycopg://ai_app:starit-app@localhost:5432/starit"
    migration_database_url: str = "postgresql+psycopg://starit:starit@localhost:5432/starit"
    # Password given to the ai_app role when the migrations create it.
    app_db_password: str = Field(default="starit-app", repr=False)
    redis_url: str = "redis://localhost:6379/0"
    s3_endpoint_url: str = "http://localhost:9000"
    s3_access_key: str = "starit"
    s3_secret_key: str = Field(default="starit-secret", repr=False)
    s3_bucket: str = "starit-documents"

    # Tokens are issued for the public (localhost) address; keys may be fetched over an
    # internal address, so the issuer to check and the JWKS URL are separate settings.
    oidc_issuer: str = "http://localhost:8080/realms/starit"
    oidc_jwks_url: str = "http://localhost:8080/realms/starit/protocol/openid-connect/certs"
    oidc_audience_api: str = "starit-api"
    oidc_audience_mcp: str = "starit-mcp"


@lru_cache
def get_settings() -> Settings:
    return Settings()
