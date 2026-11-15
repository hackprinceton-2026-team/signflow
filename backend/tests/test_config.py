from __future__ import annotations

import re

import pytest
from pydantic import ValidationError

from signflow_api.config import BACKEND_DIR, Settings

from .conftest import make_settings


def test_defaults_are_safe():
    s = make_settings()
    assert s.host == "127.0.0.1"
    assert s.cors_origins == ["app://signflow", "http://localhost:5173"]
    assert s.gemini_model == "gemini-3.5-flash"
    assert s.translation_configured is False


def test_speech_defaults_to_the_generative_ruth_voice():
    s = make_settings()
    assert (s.polly_engine, s.polly_default_voice, s.polly_fallback_engine) == ("generative", "Ruth", "neural")


def test_empty_fallback_engine_disables_the_retry(monkeypatch):
    monkeypatch.setenv("POLLY_FALLBACK_ENGINE", "")
    assert Settings(_env_file=None).polly_fallback_engine is None  # type: ignore[call-arg]


def test_reads_environment(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "AIzaSyTESTKEY")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-flash-latest")
    monkeypatch.setenv("CORS_ORIGINS", "app://signflow, https://demo.example")
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.translation_configured
    assert s.gemini_model == "gemini-flash-latest"
    assert s.cors_origins == ["app://signflow", "https://demo.example"]


def test_dotenv_key_is_not_overridden_by_a_shell_gemini_api_key(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "AIzaSySTALESHELLKEY")
    env = tmp_path / ".env"
    env.write_text("GOOGLE_API_KEY=from-file\n")
    s = Settings(_env_file=env)  # type: ignore[call-arg]
    assert s.google_api_key is not None and s.google_api_key.get_secret_value() == "from-file"
    assert Settings(_env_file=None).google_api_key is None  # type: ignore[call-arg]


def test_reads_dotenv_file(tmp_path):
    env = tmp_path / ".env"
    env.write_text("GOOGLE_API_KEY=from-file\nPOLLY_DEFAULT_VOICE=Matthew\n")
    s = Settings(_env_file=env)  # type: ignore[call-arg]
    assert s.google_api_key is not None and s.google_api_key.get_secret_value() == "from-file"
    assert s.polly_default_voice == "Matthew"


def test_secrets_never_appear_in_repr():
    s = make_settings(google_api_key="AIzaSyVERYSECRET")
    assert "VERYSECRET" not in repr(s)
    assert "VERYSECRET" not in str(s.model_dump())


@pytest.mark.parametrize(
    "overrides",
    [
        {"cors_origins": ["*"]},
        {"port": 0},
        {"gemini_temperature": 3},
        {"polly_default_voice": "bad voice"},
        {"polly_engine": "turbo"},
    ],
)
def test_rejects_unsafe_or_invalid_values(overrides):
    with pytest.raises(ValidationError):
        make_settings(**overrides)


def test_env_example_documents_every_setting_without_secrets():
    example = (BACKEND_DIR / ".env.example").read_text()
    for name in Settings.model_fields:
        assert re.search(rf"^#?\s*{name.upper()}=", example, re.MULTILINE), name
    assert re.search(r"^GOOGLE_API_KEY=\s*$", example, re.MULTILINE), "the example key must be empty"
    assert "AIza" not in example and "AKIA" not in example
