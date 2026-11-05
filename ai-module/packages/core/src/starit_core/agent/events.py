"""文件：agent/events.py
作用：一次运行向正在监听的客户端发送的事件（契约见 docs/design/03 第 4.1 节）。
主要思想：RunEmitter 记住“客户端已经看到了多少回答文字”（open_text），因为流式输出是
先发后验：校验没通过时要撤回（message.retract），运行结束时还要把已发出的文字与最终回复对齐。
"""

import time
from collections.abc import Awaitable, Callable
from typing import Any

from starit_core import telemetry

# 接收事件的函数类型：(事件名, 数据) -> 异步。API 层把它接到 SSE 队列。
Sink = Callable[[str, dict[str, Any]], Awaitable[None]]


class RunEmitter:
    """事件发送器：发送 delta/retract 等事件，并记录已展示的文字与首字延迟。"""

    def __init__(self, sink: Sink, started: float | None = None) -> None:
        self._sink = sink
        self._started = started if started is not None else time.perf_counter()
        self.open_text = ""
        self._first = True

    async def event(self, name: str, data: dict[str, Any]) -> None:
        await self._sink(name, data)

    async def delta(self, text: str) -> None:
        """发出一段新增的回答文字；第一次发出时记录“首字出现用时”指标。"""
        if not text:
            return
        if self._first:
            self._first = False
            telemetry.current().run_first_token.record(time.perf_counter() - self._started)
        self.open_text += text
        await self._sink("message.delta", {"text": text})

    async def retract(self, reason: str) -> None:
        """Take back what the client was shown. Nothing is sent if nothing was shown."""
        if not self.open_text:
            return
        self.open_text = ""
        await self._sink("message.retract", {"reason": reason})
