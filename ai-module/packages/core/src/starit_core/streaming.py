"""文件：streaming.py
作用：模型还在输出 JSON 回复时，实时把其中 `answer` 字段的文字抠出来，供前端边写边显示。
背景：回答步骤要求模型返回一个 JSON 对象 {"sufficient": true, "answer": "...", "citations": [1]}。
流式时到达的字符是 JSON 本身，不是回答文字，所以不能直接转发。
主要思想：一个逐字符的小状态机：跟踪最外层对象，跳过不需要的值，边接收边解码 answer 字符串
（转义、Unicode 转义序列、代理对，以及任何一种在块中间被截断的情况）。
安全规则：只有已确认 `sufficient` 为 true 才放出文字。sufficient 为 false 什么都不放；
模型把 answer 写在 sufficient 前面时，也什么都不放，调用方在结束时一次性发整段（等同没有流式）。
已放出的文字永远是最终回答的前缀，调用方拿它与解析后的完整回复比较并补齐差异。
"""

import re

_WHITESPACE = " \t\r\n"
# JSON 的单字符转义对照表
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
# 遇到坏的转义或孤立的代理项时用的替换字符
REPLACEMENT = "�"


class _String:
    """逐字符解码一个 JSON 字符串，处理转义、Unicode 十六进制转义和 UTF-16 代理对。"""

    def __init__(self) -> None:
        self._escape: str | None = None  # None, "\\" or "\\u" plus the hex digits so far
        self._high: int | None = None  # a high surrogate waiting for its low half

    def push(self, char: str) -> tuple[str, bool]:
        """喂入一个字符。

        返回：(解码出的文字, 是否遇到了结束引号)。转义序列没收齐时返回空文字，等下个字符。
        """
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
        """有等待低位的高位代理项却没等到：补一个替换字符，避免丢字也避免乱码。"""
        if self._high is None:
            return ""
        self._high = None
        return REPLACEMENT


class AnswerStream:
    """喂入回复的各个片段，返回此刻可以展示的回答文字。

    参数：
      require_sufficient：是否要等 sufficient=true 才放出文字
        （数据类回答没有这个字段，传 False）；
      key：要抠出的字段名，默认 answer。
    属性：
      sufficient：模型的判断；
      deferred：answer 先于 sufficient 出现（此后不放文字）；
      emitted：已放出的文字。
    """

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
        """喂入一个片段，返回此刻可展示的文字片段列表（通常 0 或 1 个）。"""
        released: list[str] = []
        for char in chunk:
            text = self._step(char)
            if text:
                released.append(text)
        return ["".join(released)] if released else []

    # --- the state machine ----------------------------------------------------------------

    # 状态机：state 依次是 start -> key_or_end/key_next -> key -> after_key -> before_value ->
    # (answer | skip_string | skip_nested | skip_literal) -> after_value -> ... -> done
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
        """遇到一个值的开头：是目标字段的字符串就开始解码，否则按类型进入对应的“跳过”状态。"""
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
        """跳过嵌套的对象/数组：数括号深度，同时识别字符串（里面的括号不算）。"""
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
        """一个裸值（true/false/数字）读完；若是 sufficient 就记下真假。"""
        if self._key == "sufficient":
            if self._literal == "true":
                self.sufficient = True
            elif self._literal == "false":
                self.sufficient = False
        self._literal = ""
        self._state = "after_value"

    def _release(self, text: str) -> str:
        """决定这段新解码的文字能不能放出：被推迟、sufficient 为假或未确认时都不放。"""
        if not text or self.deferred or self.sufficient is False:
            return ""
        if self._require_sufficient and self.sufficient is not True:
            return ""
        self.emitted += text
        return text
