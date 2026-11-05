"""文件：测试——JSON 日志
测什么：日志是一行 JSON，有请求 ID 时带上，没有时不带这个字段。
"""

import json
import logging

from starit_core.logging import JsonFormatter, request_id_var


def test_json_log_includes_request_id() -> None:
    record = logging.LogRecord("t", logging.INFO, __file__, 1, "hello %s", ("world",), None)
    token = request_id_var.set("req-123")
    try:
        data = json.loads(JsonFormatter().format(record))
    finally:
        request_id_var.reset(token)
    assert data["message"] == "hello world"
    assert data["request_id"] == "req-123"
    assert data["level"] == "INFO"


def test_json_log_without_request_id() -> None:
    record = logging.LogRecord("t", logging.WARNING, __file__, 1, "x", (), None)
    assert "request_id" not in json.loads(JsonFormatter().format(record))
