"""文件：config.py
作用：全部配置项的定义。所有项都可以用环境变量覆盖，前缀 `STARIT_`（嵌入相关另可用无前缀名），
本地开发时读取 `.env` 文件；Docker Compose 里由 compose.yaml 注入。
主要思想：所有可调的东西（模型名、检索参数、上限、超时、端口地址）都放在这里，
代码里不写死；默认值与 deploy/compose/compose.yaml 一致，所以不配置也能在本机跑起来。
分组：基础设施 / 嵌入 / 模型网关 / 限流与预算 / 检索 / 助手 / 数据问答 / 可观测 / 入库 / 身份。
"""

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置。pydantic-settings 会从环境变量和 .env 读取；extra=ignore 表示忽略无关变量。"""

    model_config = SettingsConfigDict(env_prefix="STARIT_", env_file=".env", extra="ignore")

    # —— 基础：运行环境与日志级别
    env: str = "dev"
    log_level: str = "INFO"

    # Defaults match deploy/compose/compose.yaml so a local run works without configuration.
    # The application connects as the ordinary role ai_app; only migrations use the owner.
    # —— 基础设施：数据库、Redis、对象存储（默认值对应本地 Compose）
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
    # —— 嵌入模型：换模型只需改配置并重新入库（向量列固定 1536 维）
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
    # Derived content (summary and questions per chunk): none, summary, questions or all. Off by
    # default; the evaluation decides whether it earns its cost (design 05, section 1.5).
    # —— 入库时可选生成“摘要/问题”等检索辅助内容；默认关闭，由评测决定值不值得
    ingest_derive: str = "none"
    model_derive: str = "openai/gpt-6-luna"
    model_judge: str = "openai/gpt-6-luna"  # grades answers in the evaluation

    # How models are reached. "litellm_lib" calls the provider from this process with the key in
    # this process's environment; "litellm_proxy" sends every call to the LiteLLM gateway
    # service, which alone holds the provider keys (docs/design/01, section 4.2).
    # —— 模型调用方式：直接调厂商，或统一走 LiteLLM 网关（只有网关持有厂商密钥）
    llm_gateway: str = "litellm_lib"
    llm_gateway_url: str = "http://localhost:4100"
    llm_gateway_key: str = Field(default="", repr=False)
    # Models to try, in order, when a chat call fails (comma separated, after the model asked for):
    # provider errors, timeouts, rate limits, an unknown model. Not for bad answers.
    llm_fallbacks: str = ""

    # Limits on the chat endpoint (docs/design/03, section 7), three dimensions: the user (above:
    # rate_limit_chat_per_minute), the address, and the money the whole stack may spend per UTC day.
    # —— 聊天接口的限制：每用户、每 IP、全栈每日预算（三个维度）
    rate_limit_ip_per_minute: int = 60
    trusted_proxies: str = ""  # comma separated networks whose X-Forwarded-For is believed
    daily_budget_usd: float = 0.5  # 0 switches the budget off

    # Retrieval (docs/design/05-retrieval-etl-and-evaluation.md, section 2).
    # —— 检索参数：模式、各路候选数、融合常数、重排输入数、最终块数与 token 预算
    retrieval_mode: str = "hybrid_rerank"  # keyword, vector, hybrid or hybrid_rerank
    keyword_searcher: str = "ts_rank_cd"
    retrieval_identifier_boost: bool = True  # exact identifiers (ERR-PORTAL-403) get a bonus
    retrieval_keyword_k: int = 30
    retrieval_vector_k: int = 30
    retrieval_rrf_k: int = 60
    retrieval_rerank_in: int = 20
    retrieval_final_k: int = 6
    retrieval_context_tokens: int = 3500
    # Each passage is cut to this many tokens in the rerank prompt. It must be at least the chunk
    # size limit (500): a cut passage hides what is at its end, and the answer to ERR-PORTAL-429
    # sat at token 365 of its chunk, which a 350-token cut scored 2 out of 10.
    rerank_passage_tokens: int = 600
    model_rerank: str = "openai/gpt-6-luna"

    # The assistant (docs/design/04-agent-flow.md). One model per step, so each can be changed.
    # —— 助手：每个步骤用的模型各自可配，以及重试、超时、步数上限
    model_understand: str = "openai/gpt-6-luna"
    model_generate: str = "openai/gpt-6-luna"
    agent_history_turns: int = 6  # earlier turns are dropped, not summarised
    agent_max_input_chars: int = 2000
    agent_max_llm_calls: int = 8  # per run, including the reranker and SQL retries
    agent_max_clarifications: int = 2
    agent_retrieval_retries: int = 1
    agent_verify_retries: int = 1
    agent_run_timeout_seconds: float = 60.0
    agent_llm_timeout_seconds: float = 30.0
    agent_recursion_limit: int = 20

    # Data questions (docs/design/04-agent-flow.md, the data path).
    # —— 数据问答：规划/写 SQL 的模型、重试、行数与超时上限
    model_plan: str = "openai/gpt-6-luna"
    model_sql: str = "openai/gpt-6-luna"
    agent_max_sql_retries: int = 2
    data_max_rows: int = 200
    data_rows_to_model: int = 40  # more rows than this are summarised for the model, not sent
    data_statement_timeout_ms: int = 5000
    data_tools_backend: str = (
        "local"  # "mcp": call the MCP server with the user's token; "local": in process
    )
    mcp_url: str = "http://localhost:8100/mcp"
    mcp_port: int = 8100
    # OpenTelemetry: off by default; Compose turns it on with `make up-obs`.
    # —— 可观测：OpenTelemetry 默认关，make up-obs 时开启
    otel_enabled: bool = False
    otel_endpoint: str = "http://localhost:4318"  # OTLP/HTTP (the Collector)
    otel_capture_content: bool = False  # put prompts and answers in spans (off: privacy)
    # Browser origins allowed to call the API (comma separated).
    # —— 网页来源白名单与 MCP 允许的 Host
    cors_origins: str = "http://localhost:3000"
    # Host header values the MCP server accepts (DNS-rebinding protection stays on).
    mcp_allowed_hosts: str = "localhost:8100,127.0.0.1:8100,mcp-server:8100"
    # The first of two gates before answering: the best passage must score at least this much
    # in the rerank (0-10). The second gate is the answer step saying the passages are enough.
    # —— 回答前的两道门：重排最高分阈值；被权限挡住的命中的关键词分阈值
    grade_min_rerank_score: float = 6.0
    # Hidden matches count as "there is restricted content" above this keyword score. On the
    # sample questions, questions about restricted documents scored 0.57-0.74 and unanswerable
    # ones 0.09-0.41 (docs/design/08-milestone-checklists.md, M5).
    grade_restricted_min_keyword_score: float = 0.5
    rate_limit_chat_per_minute: int = 20

    # Chunking (tokens counted with the cl100k_base tokenizer).
    # —— 切块：目标/最大/重叠 token 数
    chunk_target_tokens: int = 400
    chunk_max_tokens: int = 500
    chunk_overlap_tokens: int = 50

    # Ingestion worker.
    # —— 入库 worker：轮询间隔、任务卡住多久后重新排队
    worker_poll_seconds: float = 2.0
    worker_stale_job_seconds: int = 900

    # Tokens are issued for the public (localhost) address; keys may be fetched over an
    # internal address, so the issuer to check and the JWKS URL are separate settings.
    # —— 身份：令牌签发者、验签公钥地址、两个服务的受众名
    oidc_issuer: str = "http://localhost:8080/realms/starit"
    oidc_jwks_url: str = "http://localhost:8080/realms/starit/protocol/openid-connect/certs"
    oidc_audience_api: str = "starit-api"
    oidc_audience_mcp: str = "starit-mcp"


@lru_cache
def get_settings() -> Settings:
    """取全局配置（带缓存，进程内只读一次）。测试里常直接构造 Settings 来覆盖。"""
    return Settings()
