"""FastAPI application.

Two separate steps keep speech behind the user's confirmation:

1. ``POST /translate``: glosses → English *text* only, shown to the user as a draft.
2. ``POST /speak``: called by the app only after the user confirms (and possibly
   edits) the draft. It speaks exactly the text it is given.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import Settings, get_settings
from .errors import ApiError, SpeechUnavailable, TranslationUnavailable, install_error_handlers
from .schemas import (
    ErrorResponse,
    HealthResponse,
    SpeechRequest,
    SpeechResponse,
    TranslationRequest,
    TranslationResponse,
)
from .speech import PollySynthesizer, SpeechSynthesizer, aws_credentials_available
from .translation import GeminiTranslator, Translator

log = logging.getLogger("signflow")


def _errors(*codes: int) -> dict[int | str, dict]:
    descriptions = {
        422: "Invalid request",
        502: "The AI or speech provider failed",
        503: "The provider is not configured on the server",
        504: "The provider timed out",
    }
    return {code: {"model": ErrorResponse, "description": descriptions[code]} for code in codes}


def create_app(
    settings: Settings | None = None,
    *,
    translator: Translator | None = None,
    synthesizer: SpeechSynthesizer | None = None,
    speech_configured: Callable[[], bool] | None = None,
) -> FastAPI:
    """Build the app. Providers can be injected (tests); otherwise they are created
    lazily from settings on first use, so a missing credential returns a clear 503
    instead of crashing at startup."""
    settings = settings or get_settings()
    providers: dict[str, object] = {}

    def get_translator() -> Translator:
        if translator is not None:
            return translator
        if "translator" not in providers:
            if not settings.translation_configured or settings.google_api_key is None:
                raise TranslationUnavailable()
            providers["translator"] = GeminiTranslator(
                api_key=settings.google_api_key,
                model=settings.gemini_model,
                temperature=settings.gemini_temperature,
                timeout_s=settings.translate_timeout_s,
            )
        return providers["translator"]  # type: ignore[return-value]

    def get_synthesizer() -> SpeechSynthesizer:
        if synthesizer is not None:
            return synthesizer
        if "synthesizer" not in providers:
            providers["synthesizer"] = PollySynthesizer(
                region=settings.aws_region, engine=settings.polly_engine, timeout_s=settings.speak_timeout_s
            )
        return providers["synthesizer"]  # type: ignore[return-value]

    def is_speech_configured() -> bool:
        if speech_configured is not None:
            return speech_configured()
        return synthesizer is not None or aws_credentials_available(settings.aws_region)

    app = FastAPI(
        title="SignFlow API",
        version=__version__,
        description=(
            "ASL gloss → English translation, and speech for text the user has confirmed. "
            "`/translate` never produces audio; the desktop app calls `/speak` only after confirmation."
        ),
    )
    install_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,  # no cookies or auth headers are used
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        max_age=600,
    )

    @app.middleware("http")
    async def _no_store(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        response = await call_next(request)
        # Responses contain what the user said; don't let anything cache them.
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health", response_model=HealthResponse, operation_id="health", tags=["system"])
    async def health() -> HealthResponse:
        """Liveness plus which providers are configured. Never includes secrets."""
        return HealthResponse(
            version=__version__,
            translation="ready" if (translator is not None or settings.translation_configured) else "not_configured",
            speech="ready" if is_speech_configured() else "not_configured",
            model=translator.model_name if translator is not None else settings.gemini_model,
        )

    @app.post(
        "/translate",
        response_model=TranslationResponse,
        operation_id="translate",
        tags=["translation"],
        responses=_errors(422, 502, 503, 504),
    )
    async def translate(request: TranslationRequest) -> TranslationResponse:
        """Translate ASL glosses into an English draft. Returns text only, never audio."""
        engine = get_translator()
        text = await engine.translate([g.upper() for g in request.raw_signs], request.mode)
        log.info("translated %d signs (%s) → %d chars", len(request.raw_signs), request.mode, len(text))
        return TranslationResponse(translated_text=text, mode=request.mode, model=engine.model_name)

    @app.post(
        "/speak",
        response_model=SpeechResponse,
        operation_id="speak",
        tags=["speech"],
        responses=_errors(422, 502, 503, 504),
    )
    async def speak(request: SpeechRequest) -> SpeechResponse:
        """Synthesize speech for text the user has **already confirmed** in the app."""
        voice_id = request.voice_id or settings.polly_default_voice
        try:
            audio = await get_synthesizer().synthesize(request.text, voice_id)
        except ApiError:
            raise
        except Exception as exc:  # provider construction failures, e.g. a broken AWS profile
            log.warning("Speech synthesizer unavailable: %s", type(exc).__name__)
            raise SpeechUnavailable() from exc
        log.info("spoke %d chars with %s → %d bytes", len(request.text), voice_id, len(audio))
        return SpeechResponse(audio_base64=base64.b64encode(audio).decode("ascii"), voice_id=voice_id)

    return app
