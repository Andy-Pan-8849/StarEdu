"""文件：logging.py
作用：JSON 格式日志，并在每条日志里带上请求 ID、运行 ID 和链路 trace ID。
主要思想：用 contextvars 保存“当前请求/运行”，日志格式化时自动取出，业务代码不用层层传参，
排查问题时可以用同一个 ID 把日志、链路、审计串起来。
"""

import json
import logging
from contextvars import ContextVar
from datetime import UTC, datetime

from opentelemetry import trace

# 当前 HTTP 请求的 ID（由 API 中间件设置）
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
# 当前助手运行的 ID（由 AgentRuntime 设置）
run_id_var: ContextVar[str | None] = ContextVar("run_id", default=None)


class JsonFormatter(logging.Formatter):
    """把日志记录格式化成一行 JSON：时间、级别、名称、消息，以及可用的各类 ID。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id:
            payload["request_id"] = request_id
        run_id = run_id_var.get()
        if run_id:
            payload["run_id"] = run_id
        context = trace.get_current_span().get_span_context()
        if context.is_valid:
            payload["trace_id"] = f"{context.trace_id:032x}"
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(level: str = "INFO") -> None:
    """把根日志器换成 JSON 输出；level 是日志级别名，如 INFO。"""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
