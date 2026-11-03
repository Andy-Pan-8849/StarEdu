"""Failures of an ingestion job, with the stage they happened in."""


class IngestError(Exception):
    def __init__(self, stage: str, code: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message
        self.retryable = retryable
