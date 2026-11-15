"""Opt-in live evaluation against the real Gemini API (``python -m evals --live``).

Nothing here runs unless ``--live`` is passed. It builds the *production*
``GeminiTranslator`` from the same settings the server uses (``backend/.env``
or the environment), so a live run measures exactly what ``POST /translate``
would return, including its timeout and error mapping.

The API key is only ever handed to the translator. It is never printed, never
written to a report, and any accidental occurrence in report text is redacted
before the file is written.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from signflow_api.config import Settings
from signflow_api.translation import GeminiTranslator, Translator

MODEL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$")
REDACTED = "[REDACTED]"
#: Shorter values are not treated as secrets to redact (they would mangle ordinary words).
MIN_SECRET_LENGTH = 8


class LiveUnavailable(Exception):
    """Live evaluation can't run with the current configuration (exit 2)."""


@dataclass(frozen=True)
class LiveSetup:
    translator: Translator
    model: str
    #: Non-secret settings recorded in the report so runs can be compared.
    settings: dict[str, object]
    #: Values that must never appear in output; used for redaction.
    secrets: tuple[str, ...] = field(repr=False)


def load_settings() -> Settings:
    """The server's settings: environment variables, then ``backend/.env``."""
    return Settings()


def build_live_translator(settings: Settings, *, model: str | None = None) -> LiveSetup:
    if not settings.translation_configured or settings.google_api_key is None:
        raise LiveUnavailable(
            "GOOGLE_API_KEY is not set. Add it to backend/.env (see .env.example) or export it, "
            "then run python -m evals --live again."
        )
    if model is not None and not MODEL_NAME_PATTERN.match(model):
        raise LiveUnavailable("--model must be a plain model name such as gemini-3.5-flash")
    chosen = model or settings.gemini_model
    translator = GeminiTranslator(
        api_key=settings.google_api_key,
        model=chosen,
        temperature=settings.gemini_temperature,
        timeout_s=settings.translate_timeout_s,
    )
    return LiveSetup(
        translator=translator,
        model=chosen,
        settings={"temperature": settings.gemini_temperature, "timeout_s": settings.translate_timeout_s},
        secrets=(settings.google_api_key.get_secret_value(),),
    )


def redact(text: str, secrets: Iterable[str]) -> str:
    """Replace every occurrence of each secret with ``[REDACTED]``."""
    for secret in secrets:
        value = secret.strip()
        if len(value) >= MIN_SECRET_LENGTH:
            text = text.replace(value, REDACTED)
    return text
