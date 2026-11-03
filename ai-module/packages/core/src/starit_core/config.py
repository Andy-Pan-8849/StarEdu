"""Application settings, read from environment variables (prefix STARIT_)."""

from functools import lru_cache

from pydantic import AliasChoices, Field
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

    # Embeddings. The provider, model and dimensions are variables so a different model only
    # needs a configuration change (followed by re-ingesting the documents). The vector column
    # is 1536 wide; a different width needs a new migration. Provider "fake" is for tests only.
    embedding_provider: str = Field(
        default="openai",
        validation_alias=AliasChoices("EMBEDDING_PROVIDER", "STARIT_EMBEDDING_PROVIDER"),
    )
    embedding_model: str = Field(
        default="text-embedding-3-small",
        validation_alias=AliasChoices("EMBEDDING_MODEL", "STARIT_EMBEDDING_MODEL"),
    )
    embedding_dimensions: int = Field(
        default=1536,
        validation_alias=AliasChoices("EMBEDDING_DIMENSIONS", "STARIT_EMBEDDING_DIMENSIONS"),
    )
    embedding_batch_size: int = 64

    # Retrieval (docs/design/05-retrieval-etl-and-evaluation.md, section 2).
    retrieval_mode: str = "hybrid_rerank"  # keyword, vector, hybrid or hybrid_rerank
    keyword_searcher: str = "ts_rank_cd"
    retrieval_keyword_k: int = 30
    retrieval_vector_k: int = 30
    retrieval_rrf_k: int = 60
    retrieval_rerank_in: int = 20
    retrieval_final_k: int = 6
    retrieval_context_tokens: int = 3500
    rerank_passage_tokens: int = 350  # each passage is cut to this many tokens in the rerank prompt
    model_rerank: str = "openai/gpt-6-luna"

    # Chunking (tokens counted with the cl100k_base tokenizer).
    chunk_target_tokens: int = 400
    chunk_max_tokens: int = 500
    chunk_overlap_tokens: int = 50

    # Ingestion worker.
    worker_poll_seconds: float = 2.0
    worker_stale_job_seconds: int = 900

    # Tokens are issued for the public (localhost) address; keys may be fetched over an
    # internal address, so the issuer to check and the JWKS URL are separate settings.
    oidc_issuer: str = "http://localhost:8080/realms/starit"
    oidc_jwks_url: str = "http://localhost:8080/realms/starit/protocol/openid-connect/certs"
    oidc_audience_api: str = "starit-api"
    oidc_audience_mcp: str = "starit-mcp"


@lru_cache
def get_settings() -> Settings:
    return Settings()
