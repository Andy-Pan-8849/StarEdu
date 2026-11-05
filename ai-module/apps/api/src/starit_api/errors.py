"""文件：errors.py
作用：所有失败使用同一种响应格式（见 docs/design/03 第 1 节）：
{"error": {"code": ..., "message": ..., "request_id": ...}}。
主要思想：业务错误用 ApiError 抛出；框架自己的 HTTP 错误和请求校验错误也被转成同一格式，
并带上 request_id，前端和排查日志时都只要处理一种形状。
"""

from collections.abc import Mapping

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starit_core.logging import request_id_var
from starlette.exceptions import HTTPException as StarletteHTTPException

# HTTP 状态码 -> 错误码；没列出的按 internal_error
_CODE_BY_STATUS = {
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
}


class ApiError(Exception):
    """业务错误：HTTP 状态码、错误码、给用户看的信息，以及可选的响应头（如 Retry-After）。"""

    def __init__(
        self, status_code: int, code: str, message: str, headers: Mapping[str, str] | None = None
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers


def error_response(
    status_code: int, code: str, message: str, headers: Mapping[str, str] | None = None
) -> JSONResponse:
    """生成统一格式的错误响应，自动带上当前请求的 request_id。"""
    body = {"error": {"code": code, "message": message, "request_id": request_id_var.get()}}
    return JSONResponse(body, status_code=status_code, headers=headers)


def register_error_handlers(app: FastAPI) -> None:
    """把三类错误（ApiError、HTTP 错误、请求校验错误）的处理器注册到应用上。"""

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status_code, exc.code, exc.message, exc.headers)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _CODE_BY_STATUS.get(exc.status_code, "internal_error")
        return error_response(exc.status_code, code, str(exc.detail), exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return error_response(422, "validation_error", "Request validation failed")
