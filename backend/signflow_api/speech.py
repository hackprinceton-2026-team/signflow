"""Text-to-speech for confirmed text with Amazon Polly."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

from .errors import SpeechUnavailable, UpstreamError, UpstreamTimeout

log = logging.getLogger("signflow")


class SpeechSynthesizer(Protocol):
    async def synthesize(self, text: str, voice_id: str) -> bytes: ...


def aws_credentials_available(region: str) -> bool:
    """Whether boto3 can find credentials (env, profile, SSO, ...). Local check, no network."""
    import boto3

    try:
        return boto3.Session(region_name=region).get_credentials() is not None
    except Exception:  # noqa: BLE001 - a broken profile means "not configured"
        return False


class PollySynthesizer:
    def __init__(self, *, region: str, engine: str, timeout_s: float, client: Any | None = None) -> None:
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
        self._engine = engine
        self._timeout_s = timeout_s

    def _synthesize_sync(self, text: str, voice_id: str) -> bytes:
        response = self._client.synthesize_speech(Text=text, OutputFormat="mp3", VoiceId=voice_id, Engine=self._engine)
        stream = response["AudioStream"]
        try:
            return stream.read()
        finally:
            stream.close()

    async def synthesize(self, text: str, voice_id: str) -> bytes:
        from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError, PartialCredentialsError

        try:
            audio = await asyncio.wait_for(
                asyncio.to_thread(self._synthesize_sync, text, voice_id), timeout=self._timeout_s
            )
        except TimeoutError as exc:
            raise UpstreamTimeout("The speech service took too long to respond. Try again.") from exc
        except (NoCredentialsError, PartialCredentialsError) as exc:
            raise SpeechUnavailable() from exc
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "Unknown")
            log.warning("Polly rejected the request: %s", code)
            raise UpstreamError("The speech service rejected the request (check the voice and text).") from exc
        except BotoCoreError as exc:
            log.warning("Polly request failed: %s", type(exc).__name__)
            raise UpstreamError("The speech service failed to respond. Try again.") from exc

        if not audio:
            raise UpstreamError("The speech service returned no audio. Try again.")
        return audio
