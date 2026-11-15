"""Live Gemini evaluation is opt-in, uses the production translator, and never leaks the key.

No test here calls Gemini: the production ``GeminiTranslator`` is replaced by a fake.
"""

from __future__ import annotations

import io
import json
from collections.abc import Sequence
from pathlib import Path

import pytest

from evals import cli, live
from evals.dataset import load_dataset
from signflow_api import translation
from signflow_api.errors import UpstreamError

from .conftest import make_settings

FAKE_KEY = "AIzaFAKE-test-key-0123456789"
REFERENCES = {tuple(case.production_glosses()): case.references[0] for case in load_dataset().cases}


class FakeGemini:
    """Stands in for the production GeminiTranslator; records how it was built."""

    built: list[dict] = []
    reply_with_key = False

    def __init__(self, *, api_key, model: str, temperature: float, timeout_s: float) -> None:
        FakeGemini.built.append(
            {"api_key": api_key.get_secret_value(), "model": model, "temperature": temperature, "timeout_s": timeout_s}
        )
        self.model_name = model

    async def translate(self, glosses: Sequence[str], mode: str) -> str:
        if glosses == ["CALL", "AMBULANCE", "NOW"]:
            raise UpstreamError("The Gemini API quota is used up for now. Wait a minute and try again.")
        text = REFERENCES[tuple(glosses)]
        return f"{text} {FAKE_KEY}" if FakeGemini.reply_with_key and glosses == ["WHERE", "BATHROOM"] else text


class ForbiddenGemini:
    def __init__(self, **_: object) -> None:
        raise AssertionError("GeminiTranslator must not be built without --live")


@pytest.fixture(autouse=True)
def _reset_fake() -> None:
    FakeGemini.built = []
    FakeGemini.reply_with_key = False


@pytest.fixture
def settings_with_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(live, "load_settings", lambda: make_settings(google_api_key=FAKE_KEY, gemini_temperature=0.1))


@pytest.fixture
def settings_without_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(live, "load_settings", lambda: make_settings())


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = cli.main(list(argv), stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def test_live_mode_wraps_the_production_translator():
    assert live.GeminiTranslator is translation.GeminiTranslator


def test_without_live_no_gemini_client_is_built_even_with_a_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, settings_with_key: None
):
    monkeypatch.setenv("GOOGLE_API_KEY", FAKE_KEY)
    monkeypatch.setattr(live, "GeminiTranslator", ForbiddenGemini)
    code, out, err = run_cli("--out-dir", str(tmp_path))
    assert code == cli.EXIT_OK
    assert "offline" in out and "LIVE" not in err


def test_live_without_a_key_explains_what_to_do(monkeypatch: pytest.MonkeyPatch, settings_without_key: None):
    monkeypatch.setattr(live, "GeminiTranslator", ForbiddenGemini)
    code, _, err = run_cli("--live", "--no-write")
    assert code == cli.EXIT_USAGE
    assert "GOOGLE_API_KEY is not set" in err and "backend/.env" in err


def test_model_needs_live():
    code, _, err = run_cli("--model", "gemini-x", "--no-write")
    assert code == cli.EXIT_USAGE and "--model only applies with --live" in err


def test_live_and_responses_are_mutually_exclusive(capsys: pytest.CaptureFixture[str]):
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["--live", "--responses", "x.json"])
    assert exit_info.value.code == 2
    assert "not allowed with argument" in capsys.readouterr().err


@pytest.mark.parametrize("model", ["gemini 3", "../etc", "x" * 80, "gemini;rm"])
def test_unsafe_model_names_are_rejected(model: str, settings_with_key: None, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(live, "GeminiTranslator", ForbiddenGemini)
    code, _, err = run_cli("--live", "--model", model, "--no-write")
    assert code == cli.EXIT_USAGE and "--model must be a plain model name" in err


def test_live_run_uses_server_settings_and_reports_errors(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, settings_with_key: None
):
    monkeypatch.setattr(live, "GeminiTranslator", FakeGemini)
    code, out, err = run_cli("--live", "--out-dir", str(tmp_path))

    assert FakeGemini.built == [
        {"api_key": FAKE_KEY, "model": "gemini-3.5-flash", "temperature": 0.1, "timeout_s": 20.0}
    ]
    assert "LIVE: 25 real Gemini API call(s) to gemini-3.5-flash" in err
    assert code == cli.EXIT_FAILURES, "the simulated quota error fails the run"
    assert "ERROR" in out and "emerg-call-ambulance" in out

    [json_path] = tmp_path.glob("translation-eval-gemini-*.json")
    report = json.loads(json_path.read_text(encoding="utf-8"))
    assert report["run"]["live"] is True
    assert report["run"]["provider"] == "gemini" and report["run"]["model"] == "gemini-3.5-flash"
    assert report["run"]["settings"] == {"temperature": 0.1, "timeout_s": 20.0}
    assert report["summary"]["errors"] == 1 and report["summary"]["passed"] == 24
    [errored] = [case for case in report["cases"] if case["status"] == "error"]
    assert errored["error"] == {
        "code": "upstream_error",
        "message": "The Gemini API quota is used up for now. Wait a minute and try again.",
    }


def test_model_override(monkeypatch: pytest.MonkeyPatch, settings_with_key: None):
    monkeypatch.setattr(live, "GeminiTranslator", FakeGemini)
    code, _, err = run_cli("--live", "--model", "gemini-3.5-pro", "--case", "num-age-25", "--no-write")
    assert code == cli.EXIT_OK
    assert FakeGemini.built[0]["model"] == "gemini-3.5-pro"
    assert "to gemini-3.5-pro" in err


def test_the_key_never_reaches_reports_or_the_console(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, settings_with_key: None
):
    monkeypatch.setattr(live, "GeminiTranslator", FakeGemini)
    FakeGemini.reply_with_key = True  # worst case: the model echoes the key back
    code, out, err = run_cli("--live", "--out-dir", str(tmp_path))
    assert code == cli.EXIT_FAILURES
    files = list(tmp_path.iterdir())
    assert len(files) == 2
    for path in files:
        text = path.read_text(encoding="utf-8")
        assert FAKE_KEY not in text
        assert live.REDACTED in text
    assert FAKE_KEY not in out + err


def test_live_delay_applies_between_calls(monkeypatch: pytest.MonkeyPatch, settings_with_key: None):
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(live, "GeminiTranslator", FakeGemini)
    monkeypatch.setattr("evals.runner.asyncio.sleep", fake_sleep)
    args = ("--case", "num-age-25", "--case", "neg-not-understand", "--case", "num-three-brothers")
    run_cli("--live", "--delay-s", "2", *args, "--no-write")
    assert sleeps == [2.0, 2.0]


def test_negative_delay_is_rejected():
    code, _, err = run_cli("--delay-s", "-1", "--no-write")
    assert code == cli.EXIT_USAGE and "--delay-s" in err


def test_redact():
    assert live.redact(f"a {FAKE_KEY} b {FAKE_KEY}", [FAKE_KEY]) == "a [REDACTED] b [REDACTED]"
    assert live.redact("the cat", ["cat", "", "  "]) == "the cat", "short or empty values are not secrets"
    assert live.redact("nothing here", []) == "nothing here"


def test_live_setup_repr_hides_the_key(settings_with_key: None, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(live, "GeminiTranslator", FakeGemini)
    setup = live.build_live_translator(live.load_settings())
    assert FAKE_KEY not in repr(setup)
    assert setup.secrets == (FAKE_KEY,)
