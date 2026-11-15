"""The default Gemini model and settings agree across code, .env.example, README, and the API contract."""

from __future__ import annotations

import json
import re

import pytest

from signflow_api.config import BACKEND_DIR, Settings

from .conftest import make_settings

#: The model validated end to end (real-stack E2E). Change it here and everywhere at once.
VALIDATED_GEMINI_MODEL = "gemini-3.5-flash"

ENV_EXAMPLE = BACKEND_DIR / ".env.example"
README = BACKEND_DIR / "README.md"
OPENAPI = BACKEND_DIR / "openapi.json"


@pytest.fixture(autouse=True)
def _no_shell_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Compare against code defaults, not whatever the developer's shell exports."""
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)


def env_example() -> dict[str, str]:
    pairs = {}
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            pairs[key.strip()] = value.strip()
    return pairs


def test_default_model_is_the_validated_one():
    assert Settings.model_fields["gemini_model"].default == VALIDATED_GEMINI_MODEL
    assert make_settings().gemini_model == VALIDATED_GEMINI_MODEL


def test_env_example_documents_exactly_the_settings():
    assert set(env_example()) == {name.upper() for name in Settings.model_fields}


def test_env_example_values_are_the_code_defaults():
    from_example = Settings(_env_file=ENV_EXAMPLE)  # type: ignore[call-arg]
    defaults = make_settings()
    assert from_example.model_dump(exclude={"google_api_key"}) == defaults.model_dump(exclude={"google_api_key"})
    # A copied .env.example with the key left blank means "not configured", same as no key.
    assert from_example.translation_configured is defaults.translation_configured is False


def test_env_example_holds_no_credentials():
    pairs = env_example()
    assert pairs["GOOGLE_API_KEY"] == ""
    assert not [key for key in pairs if key.startswith("AWS_") and key != "AWS_REGION"]
    assert "AIza" not in ENV_EXAMPLE.read_text(encoding="utf-8")


def test_readme_states_the_default_model():
    row = next(line for line in README.read_text(encoding="utf-8").splitlines() if "`GEMINI_MODEL`" in line)
    assert f"`{VALIDATED_GEMINI_MODEL}`" in row


@pytest.mark.parametrize("schema", ["TranslationResponse", "HealthResponse"])
def test_contract_examples_use_the_default_model(schema):
    examples = json.loads(OPENAPI.read_text(encoding="utf-8"))["components"]["schemas"][schema]["examples"]
    assert [e["model"] for e in examples] == [VALIDATED_GEMINI_MODEL] * len(examples)


def test_no_other_gemini_model_is_named_in_backend_docs_or_contract():
    pattern = re.compile(r"gemini-\d+(?:\.\d+)?-[a-z]+")
    for path in (ENV_EXAMPLE, README, OPENAPI):
        assert set(pattern.findall(path.read_text(encoding="utf-8"))) <= {VALIDATED_GEMINI_MODEL}, path.name
