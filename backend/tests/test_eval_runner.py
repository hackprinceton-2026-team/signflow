"""Evaluation runner, latency statistics, reports and the offline CLI."""

from __future__ import annotations

import asyncio
import io
import json
import socket
from datetime import UTC, datetime
from pathlib import Path

import pytest

from evals import cli
from evals.dataset import EvalCase, load_dataset
from evals.report import (
    RunInfo,
    build_report,
    latency_stats,
    passed,
    percentile,
    prompt_fingerprint,
    render_markdown,
    summarize,
)
from evals.runner import (
    Reply,
    load_recorded,
    recorded_responder,
    reference_responder,
    run_case,
    run_cases,
    translator_responder,
)
from signflow_api.errors import UpstreamTimeout
from signflow_api.translation import TokenUsage, Translation

from .conftest import FakeTranslator

DATASET = load_dataset()


def make_case(**overrides: object) -> EvalCase:
    base = {
        "id": "unit",
        "category": "conversation",
        "mode": "chat",
        "glosses": ["HELLO"],
        "description": "unit test case",
        "references": ["Hello."],
    }
    return EvalCase.model_validate({**base, **overrides})


def fake_clock(*ticks: float):
    values = iter(ticks)
    return lambda: next(values)


def run_info(**overrides: object) -> RunInfo:
    moment = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
    base = {
        "provider": "reference",
        "model": "reference-answers",
        "live": False,
        "dataset_path": "evals/cases.json",
        "dataset_version": 1,
        "dataset_sha256": "0" * 64,
        "cases_total": 25,
        "latency_budget_ms": 3000.0,
        "started_at": moment,
        "finished_at": moment,
    }
    return RunInfo(**{**base, **overrides})


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_: object, **__: object) -> None:
        raise AssertionError("offline evaluation tried to open a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


# ---------- Runner ----------


def test_reference_answers_pass_every_case():
    results = asyncio.run(run_cases(DATASET.cases, reference_responder()))
    assert [r.status for r in results] == ["pass"] * len(DATASET.cases)
    assert all(r.overlap == 1.0 for r in results)


def test_translator_gets_the_same_input_as_the_production_route():
    translator = FakeTranslator(result="Hello.")
    result = asyncio.run(
        run_case(make_case(glosses=["hello", "thank-you"], mode="medical"), translator_responder(translator))
    )
    assert translator.calls == [(["HELLO", "THANK-YOU"], "medical")]
    assert result.status == "pass"


def test_output_is_cleaned_like_production():
    result = asyncio.run(run_case(make_case(), recorded_responder({"unit": Reply('  "Hello."\n ')})))
    assert result.output == "Hello."


def test_api_errors_are_recorded_with_their_safe_message():
    result = asyncio.run(run_case(make_case(), translator_responder(FakeTranslator(error=UpstreamTimeout()))))
    assert result.status == "error"
    assert result.error == {"code": "upstream_timeout", "message": UpstreamTimeout.message}
    assert [flag.code for flag in result.flags] == ["provider_error"]
    assert result.output is None and result.overlap is None


def test_unexpected_errors_never_expose_their_text():
    boom = FakeTranslator(error=RuntimeError("key=AIzaSECRET leaked in provider text"))
    result = asyncio.run(run_case(make_case(), translator_responder(boom)))
    assert result.error == {"code": "internal_error", "message": "Unexpected RuntimeError."}
    assert "AIza" not in json.dumps(result.to_dict())


def test_missing_recorded_output_is_an_error():
    result = asyncio.run(run_case(make_case(), recorded_responder({})))
    assert result.error is not None and result.error["code"] == "missing_response"


def test_latency_is_measured_and_checked_against_the_budget():
    result = asyncio.run(
        run_case(make_case(), reference_responder(), latency_budget_ms=1000, clock=fake_clock(10.0, 11.5))
    )
    assert result.latency_ms == pytest.approx(1500)
    assert [flag.code for flag in result.flags] == ["latency_over_budget"]
    assert result.status == "pass", "slow is a warning, not a failure"


def test_recorded_latency_overrides_the_measured_one():
    respond = recorded_responder({"unit": Reply("Hello.", latency_ms=842.0)})
    result = asyncio.run(run_case(make_case(), respond, clock=fake_clock(0.0, 5.0)))
    assert result.latency_ms == 842.0


def test_cases_run_in_order_with_a_delay_between_them(monkeypatch: pytest.MonkeyPatch):
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr("evals.runner.asyncio.sleep", fake_sleep)
    seen: list[str] = []
    cases = DATASET.cases[:3]
    asyncio.run(run_cases(cases, reference_responder(), delay_s=1.5, on_result=lambda r: seen.append(r.case.id)))
    assert seen == [case.id for case in cases]
    assert sleeps == [1.5, 1.5]


# ---------- Recorded outputs ----------


def test_recorded_outputs_load_from_a_plain_mapping(tmp_path: Path):
    path = tmp_path / "responses.json"
    path.write_text(json.dumps({"a": "Hi.", "b": {"output": "Yo.", "latency_ms": 12}}), encoding="utf-8")
    recorded = load_recorded(path)
    assert recorded.replies == {"a": Reply("Hi."), "b": Reply("Yo.", 12.0)}
    assert recorded.model is None


def test_recorded_outputs_load_from_a_report(tmp_path: Path):
    report = {
        "run": {"model": "gemini-3.5-flash"},
        "cases": [
            {"id": "a", "output": "Hi.", "latency_ms": 640.2},
            {"id": "b", "output": None, "latency_ms": 20000.0},
        ],
    }
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    recorded = load_recorded(path)
    assert recorded.replies == {"a": Reply("Hi.", 640.2)}, "errored cases stay missing"
    assert recorded.model == "gemini-3.5-flash"


@pytest.mark.parametrize("content", ['["Hi."]', '{"a": 3}', '{"a": {"output": "Hi.", "latency_ms": "fast"}}'])
def test_malformed_recorded_outputs_are_rejected(tmp_path: Path, content: str):
    path = tmp_path / "bad.json"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(ValueError):
        load_recorded(path)


# ---------- Statistics and summary ----------


def test_percentiles_use_nearest_rank():
    values = [100.0 * n for n in range(1, 11)]
    assert (percentile(values, 50), percentile(values, 90), percentile(values, 95)) == (500, 900, 1000)
    assert percentile([7.0], 95) == 7.0
    with pytest.raises(ValueError):
        percentile([], 50)


def test_latency_stats():
    assert latency_stats([300.0, 100.0, 200.0]) == {
        "count": 3,
        "min": 100.0,
        "mean": 200.0,
        "p50": 200.0,
        "p90": 300.0,
        "p95": 300.0,
        "max": 300.0,
    }
    assert latency_stats([])["p95"] is None


def test_summary_counts_statuses_flags_and_fidelity():
    negated = make_case(
        id="neg", category="negation", glosses=["NOT", "KNOW"], references=["I don't know."], negation=True
    )
    numbers = make_case(id="num", category="numbers", mode="medical", glosses=["3"], references=["Three."], numbers=[3])
    respond = recorded_responder({"neg": Reply("I know."), "num": Reply("Three.")})
    results = asyncio.run(run_cases([negated, numbers, make_case(id="gone")], respond))
    summary = summarize(results)
    assert {k: summary[k] for k in ("cases", "passed", "failed", "errors", "pass_rate")} == {
        "cases": 3,
        "passed": 1,
        "failed": 1,
        "errors": 1,
        "pass_rate": 0.333,
    }
    assert summary["flags"] == {"negation_dropped": 1, "provider_error": 1}
    assert summary["fidelity"]["negation"] == {"checked": 2, "flagged": 1, "pass_rate": 0.5}
    assert summary["fidelity"]["numbers"] == {"checked": 2, "flagged": 0, "pass_rate": 1.0}
    assert summary["by_mode"] == {
        "chat": {"cases": 2, "passed": 0, "failed": 1, "errors": 1},
        "medical": {"cases": 1, "passed": 1, "failed": 0, "errors": 0},
    }
    assert summary["latency_ms"]["count"] == 2, "errors are left out of latency statistics"


# ---------- Reports ----------


def test_report_is_json_serializable_and_self_describing():
    results = asyncio.run(run_cases(DATASET.cases[:2], reference_responder()))
    report = json.loads(json.dumps(build_report(results, run_info())))
    assert report["schema_version"] == 1
    assert report["run"]["prompt_sha256"] == prompt_fingerprint()
    assert report["run"]["dataset"]["path"] == "evals/cases.json"
    assert report["run"]["started_at"] == "2026-11-14T12:00:00Z"
    assert [case["id"] for case in report["cases"]] == [case.id for case in DATASET.cases[:2]]
    assert passed(report)


def test_prompt_fingerprint_tracks_the_production_prompt(monkeypatch: pytest.MonkeyPatch):
    from langchain_core.prompts import ChatPromptTemplate

    original = prompt_fingerprint()
    assert len(original) == 64
    monkeypatch.setattr(
        "evals.report.PROMPT", ChatPromptTemplate.from_messages([("system", "other {mode}"), ("human", "{glosses}")])
    )
    assert prompt_fingerprint() != original


def test_markdown_report_lists_failures_and_escapes_tables():
    case = make_case(glosses=["NOT", "KNOW"], references=["I don't know."], negation=True)
    results = asyncio.run(run_cases([case], recorded_responder({"unit": Reply("I know | and\nmore.")})))
    markdown = render_markdown(build_report(results, run_info()))
    assert markdown.startswith("# SignFlow translation evaluation\n\n**FAIL**: 0/1 cases passed")
    assert "### `unit` (chat): fail" in markdown
    assert "- `negation_dropped` (fail): signs are negated; output has no negation" in markdown
    assert "I know \\| and more." in markdown
    assert "Offline latencies measure the harness" in markdown
    table_rows = [line for line in markdown.splitlines() if line.startswith("| `unit`")]
    assert len(table_rows) == 1 and table_rows[0].count(" | ") == 7
    assert "## Tokens" not in markdown, "offline runs have no token usage"


# ---------- Token usage ----------


class DetailedTranslator(FakeTranslator):
    """A translator that also reports token usage, like ``GeminiTranslator.translate_detailed``."""

    def __init__(self, usage: TokenUsage | None) -> None:
        super().__init__("Hello.")
        self.usage = usage

    async def translate_detailed(self, glosses, mode) -> Translation:
        return Translation(await self.translate(glosses, mode), self.usage)


def test_live_responder_records_token_usage_when_the_translator_reports_it():
    translator = DetailedTranslator(TokenUsage(input_tokens=90, output_tokens=420, reasoning_tokens=400))
    [result] = asyncio.run(run_cases([make_case()], translator_responder(translator)))
    assert translator.calls == [(["HELLO"], "chat")], "one request per case, nothing added"
    assert result.status == "pass"
    assert result.to_dict()["usage"] == {"input_tokens": 90, "output_tokens": 420, "reasoning_tokens": 400}


def test_translators_without_usage_still_work():
    [result] = asyncio.run(run_cases([make_case()], translator_responder(FakeTranslator("Hello."))))
    assert result.status == "pass" and result.to_dict()["usage"] is None


def test_token_summary_and_markdown():
    translator = DetailedTranslator(TokenUsage(input_tokens=90, output_tokens=420, reasoning_tokens=400))
    results = asyncio.run(run_cases([make_case()], translator_responder(translator)))
    report = build_report(results, run_info(live=True))
    assert report["summary"]["tokens"] == {
        "count": 1,
        "mean_input": 90.0,
        "mean_output": 420.0,
        "mean_reasoning": 400.0,
        "max_reasoning": 400,
    }
    markdown = render_markdown(report)
    assert "## Tokens" in markdown and "| 1 | 90.0 | 420.0 | 400.0 | 400 |" in markdown
    [row] = [line for line in markdown.splitlines() if line.startswith("| `unit`")]
    assert row.split(" | ")[4] == "400", "thinking tokens column"


def test_token_summary_is_empty_without_usage():
    results = asyncio.run(run_cases([make_case()], reference_responder()))
    assert summarize(results)["tokens"]["count"] == 0


def test_recorded_usage_survives_rescoring(tmp_path: Path):
    usage = {"input_tokens": 90, "output_tokens": 420, "reasoning_tokens": 400}
    report = {"cases": [{"id": "a", "output": "Hi.", "latency_ms": 640.2, "usage": usage}]}
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    assert load_recorded(path).replies == {"a": Reply("Hi.", 640.2, TokenUsage(90, 420, 400))}


@pytest.mark.parametrize(
    "usage", [None, "lots", {"input_tokens": 1}, {"input_tokens": -1, "output_tokens": 1, "reasoning_tokens": 0}]
)
def test_malformed_recorded_usage_is_ignored(tmp_path: Path, usage: object):
    path = tmp_path / "report.json"
    path.write_text(json.dumps({"cases": [{"id": "a", "output": "Hi.", "usage": usage}]}), encoding="utf-8")
    assert load_recorded(path).replies == {"a": Reply("Hi.")}


# ---------- CLI (offline) ----------


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = cli.main(list(argv), stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def test_cli_default_run_is_offline_and_writes_both_reports(tmp_path: Path, no_network: None):
    code, out, _ = run_cli("--out-dir", str(tmp_path))
    assert code == cli.EXIT_OK
    assert "with reference (reference-answers), offline" in out
    assert "PASS: 25/25 passed" in out
    [json_path] = tmp_path.glob("translation-eval-reference-*.json")
    [md_path] = tmp_path.glob("translation-eval-reference-*.md")
    report = json.loads(json_path.read_text(encoding="utf-8"))
    assert report["run"]["live"] is False and report["summary"]["passed"] == 25
    assert md_path.read_text(encoding="utf-8").startswith("# SignFlow translation evaluation")
    assert str(Path.home()) not in json_path.read_text(encoding="utf-8")


def test_cli_filters_and_no_write(tmp_path: Path):
    code, out, _ = run_cli("--mode", "emergency", "--category", "negation", "--no-write", "--out-dir", str(tmp_path))
    assert code == cli.EXIT_OK
    assert "Evaluating 2 case(s)" in out
    assert not tmp_path.exists() or not any(tmp_path.iterdir())


def test_cli_rescores_recorded_outputs_and_fails_on_errors(tmp_path: Path, no_network: None):
    responses = tmp_path / "responses.json"
    responses.write_text(json.dumps({"num-age-25": "I am 52 years old.", "neg-not-understand": "I don't understand."}))
    code, out, _ = run_cli(
        "--responses",
        str(responses),
        "--case",
        "num-age-25",
        "--case",
        "neg-not-understand",
        "--out-dir",
        str(tmp_path),
    )
    assert code == cli.EXIT_FAILURES
    assert "FAIL  " in out and "[number_missing, number_added]" in out
    [json_path] = tmp_path.glob("translation-eval-recorded-*.json")
    statuses = {c["id"]: c["status"] for c in json.loads(json_path.read_text(encoding="utf-8"))["cases"]}
    assert statuses == {"neg-not-understand": "pass", "num-age-25": "fail"}


def test_cli_rescoring_its_own_report_gives_the_same_result(tmp_path: Path):
    first = tmp_path / "first"
    assert run_cli("--out-dir", str(first))[0] == cli.EXIT_OK
    [report] = first.glob("*.json")
    code, out, _ = run_cli("--responses", str(report), "--out-dir", str(tmp_path / "second"))
    assert code == cli.EXIT_OK
    assert "with recorded (reference-answers)" in out


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["--case", "nope"], "unknown case ids: nope"),
        (["--category", "poetry"], "no cases match the filters"),
        (["--responses", "/nonexistent/responses.json"], "cannot read --responses"),
    ],
)
def test_cli_usage_errors_exit_2(argv: list[str], message: str, tmp_path: Path):
    code, _, err = run_cli(*argv, "--out-dir", str(tmp_path))
    assert code == cli.EXIT_USAGE
    assert message in err
