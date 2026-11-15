"""Text-to-speech for confirmed text with Amazon Polly.

The default is Polly's Generative engine (most human-like). If the requested
voice doesn't support the configured engine, the same text is synthesized once
more with the fallback engine, and the response says which engine was used.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Protocol

from .config import PollyEngine
from .errors import SpeechUnavailable, UpstreamError, UpstreamTimeout

log = logging.getLogger("signflow")


@dataclass(frozen=True)
class SynthesisResult:
    audio: bytes
    #: The engine that actually produced ``audio`` (after any fallback).
    engine: PollyEngine


class SpeechSynthesizer(Protocol):
    async def synthesize(self, text: str, voice_id: str) -> SynthesisResult: ...


def _error_code(exc: Exception) -> str:
    from botocore.exceptions import ClientError

    if isinstance(exc, ClientError):
        return str(exc.response.get("Error", {}).get("Code", "Unknown"))
    return type(exc).__name__


def aws_credentials_available(region: str) -> bool:
    """Whether boto3 can find credentials (env, profile, SSO, ...). Local check, no network."""
    import boto3

    try:
        return boto3.Session(region_name=region).get_credentials() is not None
    except Exception:  # noqa: BLE001 - a broken profile means "not configured"
        return False


class PollySynthesizer:
    def __init__(
        self,
        *,
        region: str,
        engine: PollyEngine,
        timeout_s: float,
        fallback_engine: PollyEngine | None = None,
        client: Any | None = None,
    ) -> None:
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client(
                "polly",
                region_name=region,
                config=Config(
                    connect_timeout=5, read_timeout=timeout_s, retries={"max_attempts": 2, "mode": "standard"}
                ),
            )
        self._client = client
        self._engine: PollyEngine = engine
        self._fallback_engine: PollyEngine | None = fallback_engine if fallback_engine != engine else None
        self._timeout_s = timeout_s

    def _request(self, text: str, voice_id: str, engine: PollyEngine) -> bytes:
        response = self._client.synthesize_speech(Text=text, OutputFormat="mp3", VoiceId=voice_id, Engine=engine)
        stream = response["AudioStream"]
        try:
            return stream.read()
        finally:
            stream.close()

    def _synthesize_sync(self, text: str, voice_id: str) -> SynthesisResult:
        try:
            return SynthesisResult(self._request(text, voice_id, self._engine), self._engine)
        except Exception as exc:
            if self._fallback_engine is None or _error_code(exc) != "EngineNotSupportedException":
                raise
            log.info("Polly voice %s has no %s engine; using %s", voice_id, self._engine, self._fallback_engine)
            return SynthesisResult(self._request(text, voice_id, self._fallback_engine), self._fallback_engine)

    async def synthesize(self, text: str, voice_id: str) -> SynthesisResult:
        from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError, PartialCredentialsError

        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(self._synthesize_sync, text, voice_id), timeout=self._timeout_s
            )
        except TimeoutError as exc:
            raise UpstreamTimeout("The speech service took too long to respond. Try again.") from exc
        except (NoCredentialsError, PartialCredentialsError) as exc:
            raise SpeechUnavailable() from exc
        except ClientError as exc:
            log.warning("Polly rejected the request: %s", _error_code(exc))
            raise UpstreamError("The speech service rejected the request (check the voice and text).") from exc
        except BotoCoreError as exc:
            log.warning("Polly request failed: %s", type(exc).__name__)
            raise UpstreamError("The speech service failed to respond. Try again.") from exc

        if not result.audio:
            raise UpstreamError("The speech service returned no audio. Try again.")
        return result
