"""OpenTelemetry for the api, the worker and the MCP server.

The code is instrumented unconditionally and costs next to nothing when no SDK is set up: with
`STARIT_OTEL_ENABLED=false` (the default) every span and metric below goes to a no-op provider.
`setup_telemetry` builds the real providers, which export over OTLP/HTTP to the Collector.

What goes into a span is a decision, not a default: identifiers (run, conversation), model names,
token counts, timings, states. Never the bearer token, never the user's question or the model's
answer, unless `STARIT_OTEL_CAPTURE_CONTENT=true` is set on purpose (then the first 2,000
characters of each model call's input and output are added, which Langfuse can display).
"""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.metrics import Meter, MeterProvider, NoOpMeterProvider, Observation
from opentelemetry.trace import NoOpTracerProvider, Span, Status, StatusCode, Tracer, TracerProvider

from starit_core.config import Settings

CONTENT_LIMIT = 2000
SERVICE_NAMES = ("starit-api", "starit-worker", "starit-mcp-server")


class Telemetry:
    """The tracer and the instruments the code records to."""

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
        self.runs = meter.create_counter("starit.runs", description="Assistant runs by end state")
        self.llm_calls = meter.create_counter("starit.llm.calls", description="Model calls")
        self.llm_tokens = meter.create_counter("starit.llm.tokens", description="Model tokens")
        self.llm_duration = meter.create_histogram("starit.llm.duration", unit="s")
        self.node_duration = meter.create_histogram("starit.agent.node.duration", unit="s")
        self.retrievals = meter.create_counter("starit.retrieval.queries")
        self.retrieval_duration = meter.create_histogram("starit.retrieval.duration", unit="s")
        self.retrieval_restricted = meter.create_counter(
            "starit.retrieval.restricted_hits",
            description="Matching chunks the asker may not read (a number, never their text)",
        )
        self.tool_calls = meter.create_counter("starit.tool.calls", description="Data tool calls")
        self.ingest_jobs = meter.create_counter("starit.ingest.jobs", description="Ingestion jobs")
        self._queue_length = 0
        meter.create_observable_gauge(
            "starit.ingest.queue_length",
            callbacks=[lambda _options: [Observation(self._queue_length)]],
            description="Ingestion jobs waiting",
        )

    def set_queue_length(self, value: int) -> None:
        self._queue_length = value


_current = Telemetry()


def current() -> Telemetry:
    return _current


def use(telemetry: Telemetry) -> None:
    """Make `telemetry` the one the code records to (tests pass in-memory providers)."""
    global _current
    _current = telemetry


@contextmanager
def span(name: str, attributes: Mapping[str, Any] | None = None) -> Iterator[Span]:
    """A span that is current inside the block; an exception marks it as an error."""
    with current().tracer.start_as_current_span(
        name, attributes=dict(attributes or {}), record_exception=True, set_status_on_exception=True
    ) as active:
        yield active


def fail(active: Span, message: str) -> None:
    active.set_status(Status(StatusCode.ERROR, message))


def trace_id_hex() -> str | None:
    context = trace.get_current_span().get_span_context()
    return f"{context.trace_id:032x}" if context.is_valid else None


def clip(text: str) -> str:
    return text[:CONTENT_LIMIT]


@dataclass
class Providers:
    tracer_provider: Any
    meter_provider: Any


def setup_telemetry(settings: Settings, service: str) -> Providers | None:
    """Build the OTLP exporters and make them current. Does nothing unless enabled."""
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
    """Database spans for an async SQLAlchemy engine (statement text, no parameter values)."""
    if isinstance(current().tracer_provider, NoOpTracerProvider):
        return
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

    SQLAlchemyInstrumentor().instrument(
        engine=engine.sync_engine, tracer_provider=current().tracer_provider
    )
