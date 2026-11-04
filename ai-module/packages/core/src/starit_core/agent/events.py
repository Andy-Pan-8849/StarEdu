"""What a run tells a listening client while it works (docs/design/03, section 4.1).

`RunEmitter` is handed to the steps that stream. It remembers how much answer text the client has
been shown since the last retraction (`open_text`), because the runtime must reconcile that with
the final reply: add what is missing, or retract text that did not survive verification.
"""

import time
from collections.abc import Awaitable, Callable
from typing import Any

from starit_core import telemetry

Sink = Callable[[str, dict[str, Any]], Awaitable[None]]


class RunEmitter:
    def __init__(self, sink: Sink, started: float | None = None) -> None:
        self._sink = sink
        self._started = started if started is not None else time.perf_counter()
        self.open_text = ""
        self._first = True

    async def event(self, name: str, data: dict[str, Any]) -> None:
        await self._sink(name, data)

    async def delta(self, text: str) -> None:
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
