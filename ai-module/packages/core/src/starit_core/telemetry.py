"""文件：telemetry.py
作用：api、worker、mcp-server 共用的 OpenTelemetry（链路 + 指标）。
主要思想：代码里无条件埋点，没配置 SDK 时开销几乎为零——默认(STARIT_OTEL_ENABLED=false)所有 span
和指标都进“空实现”。`setup_telemetry` 才创建真正的提供者，经 OTLP/HTTP 导出到 Collector。
记录什么是经过取舍的：只记标识(运行/会话 ID)、模型名、token 数、耗时、状态；
绝不记令牌、用户的问题或模型的回答；只有明确设 STARIT_OTEL_CAPTURE_CONTENT=true 才附带
每次模型调用输入输出的前 2000 字（供 Langfuse 显示）。
"""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.metrics import Meter, MeterProvider, NoOpMeterProvider, Observation
from opentelemetry.trace import NoOpTracerProvider, Span, Status, StatusCode, Tracer, TracerProvider

from starit_core.config import Settings

# 开启内容记录时每段最多保留的字符数
CONTENT_LIMIT = 2000
# 三个服务在链路里的名字
SERVICE_NAMES = ("starit-api", "starit-worker", "starit-mcp-server")


class Telemetry:
    """持有 tracer 和全部指标仪器；代码通过 current() 取到它并记录。"""

    def __init__(
        self,
        tracer_provider: TracerProvider | None = None,
        meter_provider: MeterProvider | None = None,
        *,
        capture_content: bool = False,
    ) -> None:
        self.tracer_provider: TracerProvider = tracer_provider or NoOpTracerProvider()
        self.meter_provider: MeterProvider = meter_provider or NoOpMeterProvider()
        self.capture_content = capture_content
        self.tracer: Tracer = self.tracer_provider.get_tracer("starit")
        meter: Meter = self.meter_provider.get_meter("starit")
        # —— 各项指标：助手运行、模型调用(次数/token/耗时/首字/费用/备用链)、
        # 检索、限流、工具调用、入库任务
        self.runs = meter.create_counter("starit.runs", description="Assistant runs by end state")
        self.llm_calls = meter.create_counter("starit.llm.calls", description="Model calls")
        self.llm_tokens = meter.create_counter("starit.llm.tokens", description="Model tokens")
        self.llm_duration = meter.create_histogram("starit.llm.duration", unit="s")
        self.llm_first_token = meter.create_histogram(
            "starit.llm.time_to_first_token", unit="s", description="Streamed model calls"
        )
        self.run_first_token = meter.create_histogram(
            "starit.run.time_to_first_token",
            unit="s",
            description="From the request to the first answer text the user can see",
        )
        self.node_duration = meter.create_histogram("starit.agent.node.duration", unit="s")
        self.retrievals = meter.create_counter("starit.retrieval.queries")
        self.retrieval_duration = meter.create_histogram("starit.retrieval.duration", unit="s")
        self.retrieval_restricted = meter.create_counter(
            "starit.retrieval.restricted_hits",
            description="Matching chunks the asker may not read (a number, never their text)",
        )
        self.llm_cost = meter.create_counter(
            "starit.llm.cost_usd", unit="USD", description="Model spend at list price"
        )
        self.llm_fallbacks = meter.create_counter(
            "starit.llm.fallbacks", description="Chat calls answered by a fallback model"
        )
        self.rate_limited = meter.create_counter(
            "starit.rate_limited", description="Chat requests refused by a limit"
        )
        self.tool_calls = meter.create_counter("starit.tool.calls", description="Data tool calls")
        self.ingest_jobs = meter.create_counter("starit.ingest.jobs", description="Ingestion jobs")
        # 入库队列长度用“观测型仪表”：每次采集时读当前值
        self._queue_length = 0
        meter.create_observable_gauge(
            "starit.ingest.queue_length",
            callbacks=[lambda _options: [Observation(self._queue_length)]],
            description="Ingestion jobs waiting",
        )

    def set_queue_length(self, value: int) -> None:
        self._queue_length = value


# 进程里当前使用的 Telemetry；默认是空实现，setup_telemetry 或测试会替换
_current = Telemetry()


def current() -> Telemetry:
    """取当前使用的 Telemetry。"""
    return _current


def use(telemetry: Telemetry) -> None:
    """Make `telemetry` the one the code records to (tests pass in-memory providers)."""
    global _current
    _current = telemetry


@contextmanager
def span(name: str, attributes: Mapping[str, Any] | None = None) -> Iterator[Span]:
    """开一个链路 span 并在代码块内设为当前；块内抛异常会把它标成错误。"""
    with current().tracer.start_as_current_span(
        name, attributes=dict(attributes or {}), record_exception=True, set_status_on_exception=True
    ) as active:
        yield active


def fail(active: Span, message: str) -> None:
    """把 span 标记为失败并附上简短原因。"""
    active.set_status(Status(StatusCode.ERROR, message))


def trace_id_hex() -> str | None:
    """当前链路的 trace ID（32 位十六进制），没有有效链路时返回 None。"""
    context = trace.get_current_span().get_span_context()
    return f"{context.trace_id:032x}" if context.is_valid else None


def clip(text: str) -> str:
    """把文本截到 CONTENT_LIMIT 个字符以内。"""
    return text[:CONTENT_LIMIT]


@dataclass
class Providers:
    """setup_telemetry 的返回值：真实的 tracer/meter 提供者，用于进程退出时 flush。"""

    tracer_provider: Any
    meter_provider: Any


def setup_telemetry(settings: Settings, service: str) -> Providers | None:
    """创建 OTLP 导出器并设为当前；未启用时什么都不做、返回 None。

    参数：settings 配置；service 本进程的服务名（如 starit-api）。
    返回：Providers 或 None。
    """
    if not settings.otel_enabled:
        return None
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.metrics import MeterProvider as SdkMeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider as SdkTracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    endpoint = settings.otel_endpoint.rstrip("/")
    resource = Resource.create(
        {
            "service.name": service,
            "service.version": "0.1.0",
            "deployment.environment": settings.env,
        }
    )
    tracer_provider = SdkTracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
    )
    reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics"), export_interval_millis=10_000
    )
    meter_provider = SdkMeterProvider(resource=resource, metric_readers=[reader])
    use(Telemetry(tracer_provider, meter_provider, capture_content=settings.otel_capture_content))
    return Providers(tracer_provider, meter_provider)


def instrument_engine(engine: Any) -> None:
    """给异步 SQLAlchemy 引擎加数据库 span（记录 SQL 文本，不记参数值）。未启用链路时不做事。"""
    if isinstance(current().tracer_provider, NoOpTracerProvider):
        return
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

    # The instrumentor's declared range stops before the SQLAlchemy 2.1 this project uses, though
    # the engine events it listens to are the same; skip_dep_check lets it attach, and a test
    # proves that statements are really recorded.
    SQLAlchemyInstrumentor().instrument(
        engine=engine.sync_engine,
        tracer_provider=current().tracer_provider,
        skip_dep_check=True,
    )
