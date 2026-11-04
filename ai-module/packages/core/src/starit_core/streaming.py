"""Pull the answer text out of the model's JSON reply while it is still arriving.

The answering steps ask the model for one JSON object, `{"sufficient": true, "answer": "...",
"citations": [1]}`. Streamed, the characters that arrive are that JSON, not the answer. This is a
small state machine over the characters: it follows the top-level object, skips every value it
does not need, and decodes the `answer` string as it grows (escapes, `\\uXXXX`, surrogate pairs,
a chunk that ends in the middle of any of them).

The rule that keeps it safe: text is released only once `sufficient` is known to be `true`.
`sufficient: false` releases nothing. If the model writes `answer` before `sufficient`, nothing is
released at all and the caller sends the whole answer at the end, as before streaming existed.
What was released is always a prefix of the final answer; the caller compares it with the parsed
reply and corrects the difference.
"""

import re

_WHITESPACE = " \t\r\n"
_SIMPLE_ESCAPES = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
}
_HEX = re.compile(r"^[0-9a-fA-F]{4}$")
REPLACEMENT = "�"


class _String:
    """Decodes one JSON string a character at a time."""

    def __init__(self) -> None:
        self._escape: str | None = None  # None, "\\" or "\\u" plus the hex digits so far
        self._high: int | None = None  # a high surrogate waiting for its low half

    def push(self, char: str) -> tuple[str, bool]:
        """(decoded text, whether the closing quote was reached)."""
        if self._escape is None:
            if char == "\\":
                self._escape = "\\"
                return "", False
            if char == '"':
                lone = REPLACEMENT if self._high is not None else ""
                self._high = None
                return lone, True
            return self._flush_high() + char, False
        if self._escape == "\\":
            if char == "u":
                self._escape = "\\u"
                return "", False
            self._escape = None
            return self._flush_high() + _SIMPLE_ESCAPES.get(char, REPLACEMENT), False
        self._escape += char
        digits = self._escape[2:]
        if len(digits) < 4:
            return "", False
        self._escape = None
        if not _HEX.match(digits):
            return self._flush_high() + REPLACEMENT, False
        code = int(digits, 16)
        if 0xD800 <= code <= 0xDBFF:
            out = self._flush_high()
            self._high = code
            return out, False
        if 0xDC00 <= code <= 0xDFFF:
            if self._high is not None:
                joined = 0x10000 + ((self._high - 0xD800) << 10) + (code - 0xDC00)
                self._high = None
                return chr(joined), False
            return REPLACEMENT, False
        return self._flush_high() + chr(code), False

    def _flush_high(self) -> str:
        if self._high is None:
            return ""
        self._high = None
        return REPLACEMENT


class AnswerStream:
    """Feed it the chunks of the reply; it returns the answer text that may be shown now."""

    def __init__(self, *, require_sufficient: bool = True, key: str = "answer") -> None:
        self._require_sufficient = require_sufficient
        self._target = key
        self._state = "start"
        self._key = ""
        self._string: _String | None = None
        self._depth = 0
        self._in_string = False
        self._escaped = False
        self._literal = ""
        self.sufficient: bool | None = None
        self.deferred = False  # `answer` came before `sufficient`: nothing is released
        self.emitted = ""

    def feed(self, chunk: str) -> list[str]:
        """The pieces of answer text to show now (usually none or one)."""
        released: list[str] = []
        for char in chunk:
            text = self._step(char)
            if text:
                released.append(text)
        return ["".join(released)] if released else []

    # --- the state machine ----------------------------------------------------------------

    def _step(self, char: str) -> str:  # noqa: PLR0911, PLR0912
        state = self._state
        if state == "done":
            return ""
        if state == "start":
            if char == "{":
                self._state = "key_or_end"
            return ""
        if state in ("key_or_end", "key_next"):
            if char in _WHITESPACE:
                return ""
            if char == '"':
                self._string, self._key, self._state = _String(), "", "key"
            elif char == "}" and state == "key_or_end":
                self._state = "done"
            return ""
        if state == "key":
            assert self._string is not None
            text, closed = self._string.push(char)
            self._key += text
            if closed:
                self._state = "after_key"
            return ""
        if state == "after_key":
            if char == ":":
                self._state = "before_value"
            return ""
        if state == "before_value":
            return self._begin_value(char)
        if state == "answer":
            assert self._string is not None
            text, closed = self._string.push(char)
            if closed:
                self._state = "after_value"
            return self._release(text)
        if state == "skip_string":
            if self._escaped:
                self._escaped = False
            elif char == "\\":
                self._escaped = True
            elif char == '"':
                self._state = "after_value"
            return ""
        if state == "skip_nested":
            return self._skip_nested(char)
        if state == "skip_literal":
            if char in _WHITESPACE or char in ",}":
                self._finish_literal()
                return self._step(char) if char not in _WHITESPACE else ""
            self._literal += char
            return ""
        if state == "after_value":
            if char == ",":
                self._state = "key_next"
            elif char == "}":
                self._state = "done"
            return ""
        return ""

    def _begin_value(self, char: str) -> str:
        if char in _WHITESPACE:
            return ""
        if self._key == self._target and char == '"':
            self._string, self._state = _String(), "answer"
            if self._require_sufficient and self.sufficient is None:
                self.deferred = True
            return ""
        if char == '"':
            self._state, self._escaped = "skip_string", False
        elif char in "{[":
            self._state, self._depth, self._in_string, self._escaped = (
                "skip_nested",
                1,
                False,
                False,
            )
        else:
            self._state, self._literal = "skip_literal", char
        return ""

    def _skip_nested(self, char: str) -> str:
        if self._in_string:
            if self._escaped:
                self._escaped = False
            elif char == "\\":
                self._escaped = True
            elif char == '"':
                self._in_string = False
        elif char == '"':
            self._in_string = True
        elif char in "{[":
            self._depth += 1
        elif char in "}]":
            self._depth -= 1
            if self._depth == 0:
                self._state = "after_value"
        return ""

    def _finish_literal(self) -> None:
        if self._key == "sufficient":
            if self._literal == "true":
                self.sufficient = True
            elif self._literal == "false":
                self.sufficient = False
        self._literal = ""
        self._state = "after_value"

    def _release(self, text: str) -> str:
        if not text or self.deferred or self.sufficient is False:
            return ""
        if self._require_sufficient and self.sufficient is not True:
            return ""
        self.emitted += text
        return text
