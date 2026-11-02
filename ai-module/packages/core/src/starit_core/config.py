"""Application settings, read from environment variables (prefix STARIT_)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="STARIT_", env_file=".env", extra="ignore")

    env: str = "dev"
    log_level: str = "INFO"

    # Defaults match deploy/compose/compose.yaml so a local run works without configuration.
    database_url: str = "postgresql+psycopg://starit:starit@localhost:5432/starit"
    redis_url: str = "redis://localhost:6379/0"
    s3_endpoint_url: str = "http://localhost:9000"
    s3_access_key: str = "starit"
    s3_secret_key: str = Field(default="starit-secret", repr=False)
    s3_bucket: str = "starit-documents"


@lru_cache
def get_settings() -> Settings:
    return Settings()
