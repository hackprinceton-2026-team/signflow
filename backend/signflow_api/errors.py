"""Error handling: every failure becomes an ``ErrorResponse`` with a stable code.

Provider exceptions are logged server-side and replaced by safe, generic
messages. Exception text (which can contain request details or credentials
context) is never sent to clients.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .schemas import ErrorCode, ErrorDetail, ErrorResponse

log = logging.getLogger("signflow")


class ApiError(Exception):
    status_code = 500
    code: ErrorCode = "internal_error"
    message = "Something went wrong on the server."

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message


class TranslationUnavailable(ApiError):
    status_code = 503
    code: ErrorCode = "translation_unavailable"
    message = "Translation is not configured on the server (missing GOOGLE_API_KEY)."


class SpeechUnavailable(ApiError):
    status_code = 503
    code: ErrorCode = "speech_unavailable"
    message = "Speech is not configured on the server (no AWS credentials)."


class UpstreamError(ApiError):
    status_code = 502
    code: ErrorCode = "upstream_error"
    message = "The AI service failed to respond. Try again."


class UpstreamTimeout(ApiError):
    status_code = 504
    code: ErrorCode = "upstream_timeout"
    message = "The AI service took too long to respond. Try again."


def error_body(code: ErrorCode, message: str) -> dict:
    return ErrorResponse(error=ErrorDetail(code=code, message=message)).model_dump()


def _validation_message(exc: RequestValidationError) -> str:
    first = exc.errors()[0] if exc.errors() else None
    if not first:
        return "The request is invalid."
    loc = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
    # Only the location and rule are reported; the rejected input is not echoed back.
    return f"{loc}: {first.get('msg', 'invalid value')}" if loc else str(first.get("msg", "The request is invalid."))


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=error_body(exc.code, exc.message))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content=error_body("invalid_request", _validation_message(exc)))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code: ErrorCode = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "invalid_request")
        message = {404: "Not found.", 405: "Method not allowed."}.get(
            exc.status_code, "The request could not be processed."
        )
        return JSONResponse(
            status_code=exc.status_code, content=error_body(code, message), headers=getattr(exc, "headers", None)
        )

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error", exc_info=exc)
        return JSONResponse(status_code=500, content=error_body("internal_error", ApiError.message))
