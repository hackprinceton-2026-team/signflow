"""Runtime configuration.

Read from environment variables and an optional ``backend/.env`` file (never
committed; see ``.env.example``). Secrets are ``SecretStr``, so they are never
printed, logged, or returned by the API.

AWS credentials are deliberately not settings: boto3 resolves them through the
standard AWS chain (``aws configure``, ``AWS_PROFILE``, SSO, environment).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent

#: Amazon Polly voice ids are plain ASCII words (e.g. "Ruth", "Matthew").
VOICE_ID_PATTERN = r"^[A-Za-z]{2,32}$"

#: Amazon Polly synthesis engines, from most to least natural for conversation.
PollyEngine = Literal["generative", "long-form", "neural", "standard"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    # --- Translation (Gemini via LangChain) ---
    #: Only GOOGLE_API_KEY. (A GEMINI_API_KEY alias let a stale shell variable override backend/.env.)
    google_api_key: SecretStr | None = None
    gemini_model: str = Field("gemini-3.8-flash", min_length=1)
    gemini_temperature: float = Field(0.2, ge=0, le=1)
    translate_timeout_s: float = Field(20, gt=0, le=120)

    # --- Speech (Amazon Polly) ---
    aws_region: str = Field("us-east-1", min_length=1)
    #: Generative is Polly's most human-sounding engine. Ruth, Danielle and Matthew support it.
    polly_engine: PollyEngine = "generative"
    #: Used once, for the same request, when the voice doesn't support ``polly_engine``
    #: (Polly's ``EngineNotSupportedException``). Empty disables the retry.
    polly_fallback_engine: PollyEngine | None = "neural"
    polly_default_voice: str = Field("Ruth", pattern=VOICE_ID_PATTERN)
    speak_timeout_s: float = Field(20, gt=0, le=120)

    # --- HTTP server ---
    #: Exact origins allowed to call the API from a browser context. The desktop
    #: app is ``app://signflow`` in production and the Vite dev server in dev.
    cors_origins: Annotated[list[str], NoDecode] = ["app://signflow", "http://localhost:5173"]
    #: Localhost by default: the API should not be reachable from the network.
    host: str = "127.0.0.1"
    port: int = Field(8000, ge=1, le=65535)
    log_level: Literal["debug", "info", "warning", "error"] = "info"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("cors_origins")
    @classmethod
    def _no_wildcard(cls, origins: list[str]) -> list[str]:
        if "*" in origins:
            raise ValueError("CORS_ORIGINS must list origins explicitly; '*' is not allowed")
        return origins

    @field_validator("polly_fallback_engine", mode="before")
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value

    @property
    def translation_configured(self) -> bool:
        return self.google_api_key is not None and bool(self.google_api_key.get_secret_value().strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
