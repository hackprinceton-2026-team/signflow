"""Wire contract between the SignFlow desktop app and this backend.

These models are the source of truth: ``scripts/export_openapi.py`` writes them
to ``openapi.json``, from which the desktop app generates TypeScript types.
Each model carries ``examples`` that both sides validate in their tests.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .config import VOICE_ID_PATTERN, PollyEngine

TranslationMode = Literal["chat", "medical", "emergency"]

#: One ASL gloss as produced by the recognizer: an uppercase-style token such as
#: ``HELLO``, ``THANK-YOU``, ``IX-1``, lexicalized ``#IF`` or fingerspelling ``R-A-I``. Restricting the
#: alphabet keeps free-form text (and prompt injection) out of the LLM prompt.
Gloss = Annotated[
    str,
    StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9#][A-Za-z0-9#'+.\-]{0,39}$"),
]

VoiceId = Annotated[str, StringConstraints(pattern=VOICE_ID_PATTERN)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TranslationRequest(_Strict):
    """A run of recognized signs to turn into English."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {"raw_signs": ["HEADACHE", "SINCE", "YESTERDAY"], "mode": "medical"},
                {"raw_signs": ["HELLO", "NICE", "MEET", "YOU"]},
            ]
        },
    )

    raw_signs: list[Gloss] = Field(min_length=1, max_length=64, description="ASL glosses in signing order.")
    mode: TranslationMode = Field("chat", description="Context that sets the tone of the translation.")


class TranslationResponse(_Strict):
    """English draft for the user to review. No audio: speech happens only after confirmation."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "translated_text": "I've had a headache since yesterday.",
                    "mode": "medical",
                    "model": "gemini-3.5-flash",
                }
            ]
        },
    )

    translated_text: str = Field(min_length=1, max_length=2000, description="Fluent English for the glosses.")
    mode: TranslationMode
    model: str = Field(description="Model that produced the translation.")


class SpeechRequest(_Strict):
    """Text the user has already confirmed (and possibly edited) in the app."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {"text": "I've had a headache since yesterday.", "voice_id": "Ruth"},
                {"text": "Nice to meet you."},
            ]
        },
    )

    text: str = Field(min_length=1, max_length=1500, description="Confirmed text to speak.")
    voice_id: VoiceId | None = Field(
        None,
        description=(
            "Amazon Polly voice, e.g. `Ruth`, `Danielle` or `Matthew` (Generative). The server default if omitted."
        ),
    )


class SpeechResponse(_Strict):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "audio_base64": "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4",
                    "audio_format": "mp3",
                    "voice_id": "Ruth",
                    "engine": "generative",
                }
            ]
        },
    )

    audio_base64: str = Field(min_length=1, description="Base64-encoded audio.")
    audio_format: Literal["mp3"] = "mp3"
    voice_id: str = Field(description="Voice that spoke the audio.")
    engine: PollyEngine = Field(
        description="Polly engine that produced the audio: the configured one, or the fallback if the voice lacks it."
    )


ProviderStatus = Literal["ready", "not_configured"]


class HealthResponse(_Strict):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "status": "ok",
                    "version": "0.3.0",
                    "translation": "ready",
                    "speech": "not_configured",
                    "model": "gemini-3.5-flash",
                    "speech_voice": "Ruth",
                    "speech_engine": "generative",
                }
            ]
        },
    )

    status: Literal["ok"] = "ok"
    version: str
    translation: ProviderStatus
    speech: ProviderStatus
    model: str
    speech_voice: str = Field(description="Default voice for `/speak` when the request names none.")
    speech_engine: PollyEngine = Field(description="Engine `/speak` tries first.")


ErrorCode = Literal[
    "invalid_request",
    "not_found",
    "method_not_allowed",
    "translation_unavailable",
    "speech_unavailable",
    "upstream_error",
    "upstream_timeout",
    "internal_error",
]


class ErrorDetail(_Strict):
    code: ErrorCode
    message: str = Field(
        description="Human-readable, safe to show to the user. Never contains secrets or stack traces."
    )


class ErrorResponse(_Strict):
    """Every non-2xx response has this shape."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "error": {
                        "code": "translation_unavailable",
                        "message": "Translation is not configured on the server.",
                    }
                }
            ]
        },
    )

    error: ErrorDetail
