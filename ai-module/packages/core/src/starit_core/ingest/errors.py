"""文件：ingest/errors.py
作用：入库任务的失败类型，带上失败发生的阶段。
主要思想：IngestError 记录 stage(哪一步)、code(原因码)、retryable(是否值得重试)；
队列据此决定是排队重试还是直接标记失败。
"""


class IngestError(Exception):
    """入库失败。stage 阶段名；code 原因码；message 说明；retryable 为 False
    时不会重试（如维度不符）。
    """

    def __init__(self, stage: str, code: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message
        self.retryable = retryable
