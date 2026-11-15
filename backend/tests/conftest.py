from __future__ import annotations

from collections.abc import Callable, Sequence

import pytest
from fastapi.testclient import TestClient

from signflow_api.app import create_app
from signflow_api.config import PollyEngine, Settings
from signflow_api.speech import SynthesisResult


class FakeTranslator:
    model_name = "fake-model"

    def __init__(self, result: str = "Hello, nice to meet you.", error: Exception | None = None) -> None:
        self.result = result
        self.error = error
        self.calls: list[tuple[list[str], str]] = []

    async def translate(self, glosses: Sequence[str], mode: str) -> str:
        self.calls.append((list(glosses), mode))
        if self.error:
            raise self.error
        return self.result


class FakeSynthesizer:
    def __init__(
        self, audio: bytes = b"ID3fake-mp3", error: Exception | None = None, engine: PollyEngine = "generative"
    ) -> None:
        self.audio = audio
        self.error = error
        self.engine: PollyEngine = engine
        self.calls: list[tuple[str, str]] = []

    async def synthesize(self, text: str, voice_id: str) -> SynthesisResult:
        self.calls.append((text, voice_id))
        if self.error:
            raise self.error
        return SynthesisResult(self.audio, self.engine)


@pytest.fixture(autouse=True)
def _no_developer_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never see (or use) API keys from the developer's shell."""
    for name in ("GOOGLE_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(name, raising=False)


def make_settings(**overrides: object) -> Settings:
    """Settings isolated from the developer's environment and backend/.env."""
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg]


@pytest.fixture
def make_client() -> Callable[..., TestClient]:
    def _make(
        *,
        translator: FakeTranslator | None = None,
        synthesizer: FakeSynthesizer | None = None,
        speech_configured: bool = True,
        **settings: object,
    ) -> TestClient:
        app = create_app(
            make_settings(**settings),
            translator=translator,
            synthesizer=synthesizer,
            speech_configured=lambda: speech_configured,
        )
        return TestClient(app, raise_server_exceptions=False)

    return _make
