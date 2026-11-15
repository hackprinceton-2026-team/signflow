"""Summaries and report files (JSON for machines, Markdown for people)."""

from __future__ import annotations

import hashlib
import json
import math
import platform
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from signflow_api.translation import PROMPT

from .flags import FIDELITY_FAMILIES, FLAGS
from .live import redact
from .runner import CaseResult

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class RunInfo:
    provider: str
    model: str
    live: bool
    dataset_path: str
    dataset_version: int
    dataset_sha256: str
    cases_total: int
    latency_budget_ms: float
    started_at: datetime
    finished_at: datetime
    filters: dict[str, list[str]] = field(default_factory=dict)
    #: Non-secret provider settings worth comparing between runs (temperature, timeout).
    settings: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "model": self.model,
            "live": self.live,
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
            "duration_s": round((self.finished_at - self.started_at).total_seconds(), 3),
            "prompt_sha256": prompt_fingerprint(),
            "dataset": {
                "path": self.dataset_path,
                "version": self.dataset_version,
                "sha256": self.dataset_sha256,
                "cases_total": self.cases_total,
            },
            "filters": {key: value for key, value in self.filters.items() if value},
            "latency_budget_ms": self.latency_budget_ms,
            "settings": self.settings,
            "python": platform.python_version(),
        }


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def prompt_fingerprint() -> str:
    """SHA-256 of the production prompt, so runs made with different prompts are distinguishable."""
    messages = PROMPT.format_messages(glosses="{glosses}", mode="{mode}")
    canonical = json.dumps([[message.type, message.content] for message in messages], ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------- Summary ----------


def percentile(values: Sequence[float], pct: float) -> float:
    """Nearest-rank percentile (deterministic, always one of the values)."""
    if not values:
        raise ValueError("no values")
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100 * len(ordered)))
    return ordered[rank - 1]


def latency_stats(values: Sequence[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "min": None, "mean": None, "p50": None, "p90": None, "p95": None, "max": None}
    return {
        "count": len(values),
        "min": round(min(values), 1),
        "mean": round(sum(values) / len(values), 1),
        "p50": round(percentile(values, 50), 1),
        "p90": round(percentile(values, 90), 1),
        "p95": round(percentile(values, 95), 1),
        "max": round(max(values), 1),
    }


def token_stats(results: Sequence[CaseResult]) -> dict[str, float | int | None]:
    """Mean token counts over the cases whose provider reported usage (live runs only).

    Thinking statistics use only the cases that reported a thinking count;
    ``reasoning_reported`` says how many that was.
    """
    usages = [result.usage for result in results if result.usage is not None]
    reasoning = [usage.reasoning_tokens for usage in usages if usage.reasoning_tokens is not None]

    def mean(values: list[int]) -> float | None:
        return round(sum(values) / len(values), 1) if values else None

    return {
        "count": len(usages),
        "mean_input": mean([usage.input_tokens for usage in usages]),
        "mean_output": mean([usage.output_tokens for usage in usages]),
        "reasoning_reported": len(reasoning),
        "mean_reasoning": mean(reasoning),
        "max_reasoning": max(reasoning) if reasoning else None,
    }


def _count(value: float | None) -> str:
    return "not reported" if value is None else str(value)


def _tally(results: Iterable[CaseResult]) -> dict[str, int]:
    counts = Counter(result.status for result in results)
    return {
        "cases": sum(counts.values()),
        "passed": counts["pass"],
        "failed": counts["fail"],
        "errors": counts["error"],
    }


def summarize(results: Sequence[CaseResult]) -> dict:
    tally = _tally(results)
    answered = [result for result in results if result.output is not None]
    flag_counts = Counter(flag.code for result in results for flag in result.flags)

    fidelity = {}
    for family in FIDELITY_FAMILIES:
        flagged = sum(
            any(flag.family == family and flag.severity == "fail" for flag in result.flags) for result in answered
        )
        fidelity[family] = {
            "checked": len(answered),
            "flagged": flagged,
            "pass_rate": round(1 - flagged / len(answered), 3) if answered else None,
        }

    overlaps = [result.overlap for result in answered if result.overlap is not None]
    latencies = [result.latency_ms for result in answered if result.latency_ms is not None]
    return {
        **tally,
        "pass_rate": round(tally["passed"] / tally["cases"], 3) if tally["cases"] else None,
        "flags": {code: flag_counts[code] for code in FLAGS if flag_counts[code]},
        "fidelity": fidelity,
        "by_mode": {mode: _tally(r for r in results if r.case.mode == mode) for mode in _ordered(results, "mode")},
        "by_category": {
            category: _tally(r for r in results if r.case.category == category)
            for category in _ordered(results, "category")
        },
        "latency_ms": latency_stats(latencies),
        "latency_over_budget": flag_counts["latency_over_budget"],
        "tokens": token_stats(answered),
        "mean_reference_overlap": round(sum(overlaps) / len(overlaps), 3) if overlaps else None,
    }


def _ordered(results: Iterable[CaseResult], attribute: str) -> list[str]:
    return list(dict.fromkeys(getattr(result.case, attribute) for result in results))


def build_report(results: Sequence[CaseResult], run: RunInfo) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "run": run.to_dict(),
        "summary": summarize(results),
        "cases": [result.to_dict() for result in results],
    }


def passed(report: dict) -> bool:
    summary = report["summary"]
    return summary["failed"] == 0 and summary["errors"] == 0


# ---------- Markdown ----------


def _cell(value: object) -> str:
    """Table-safe text: pipes and newlines would break the Markdown table."""
    text = "" if value is None else str(value)
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ").replace("`", "'")


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.0f}%"


def _ms(value: float | None) -> str:
    return "n/a" if value is None else f"{value:,.0f} ms"


def render_markdown(report: dict) -> str:
    run, summary, cases = report["run"], report["summary"], report["cases"]
    status = "PASS" if passed(report) else "FAIL"
    lines = [
        "# SignFlow translation evaluation",
        "",
        f"**{status}**: {summary['passed']}/{summary['cases']} cases passed "
        f"({_pct(summary['pass_rate'])}), {summary['failed']} failed, {summary['errors']} errors.",
        "",
        "Synthetic gloss cases scored with deterministic checks. Not a measure of real-world accuracy.",
        "",
        "## Run",
        "",
        "| | |",
        "| --- | --- |",
        f"| Provider | {_cell(run['provider'])}{' (live API calls)' if run['live'] else ' (offline)'} |",
        f"| Model | `{_cell(run['model'])}` |",
        f"| Started | {run['started_at']} ({run['duration_s']} s) |",
        f"| Dataset | `{_cell(run['dataset']['path'])}` v{run['dataset']['version']}, "
        f"{summary['cases']} of {run['dataset']['cases_total']} cases, sha256 `{run['dataset']['sha256'][:12]}` |",
        f"| Prompt | sha256 `{run['prompt_sha256'][:12]}` |",
        f"| Latency budget | {_ms(run['latency_budget_ms'])} |",
    ]
    if run["filters"]:
        filters = "; ".join(f"{key}: {', '.join(values)}" for key, values in run["filters"].items())
        lines.append(f"| Filters | {_cell(filters)} |")
    for key, value in run["settings"].items():
        lines.append(f"| {_cell(key)} | {_cell(value)} |")

    lines += ["", "## Fidelity", "", "| Check | Cases flagged | Pass rate |", "| --- | --- | --- |"]
    for family, stats in summary["fidelity"].items():
        lines.append(f"| {family} | {stats['flagged']}/{stats['checked']} | {_pct(stats['pass_rate'])} |")

    latency = summary["latency_ms"]
    lines += [
        "",
        "## Latency",
        "",
        "| Count | Min | Mean | p50 | p90 | p95 | Max | Over budget |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        f"| {latency['count']} | {_ms(latency['min'])} | {_ms(latency['mean'])} | {_ms(latency['p50'])} | "
        f"{_ms(latency['p90'])} | {_ms(latency['p95'])} | {_ms(latency['max'])} | {summary['latency_over_budget']} |",
    ]
    if not run["live"]:
        lines += ["", "Offline latencies measure the harness, not a model."]

    tokens = summary.get("tokens") or {}
    if tokens.get("count"):
        lines += [
            "",
            "## Tokens",
            "",
            "Thinking tokens are generated before the answer, so they add directly to latency.",
            "",
            "| Cases | Mean input | Mean output | Thinking reported | Mean thinking | Max thinking |",
            "| --- | --- | --- | --- | --- | --- |",
            f"| {tokens['count']} | {tokens['mean_input']} | {tokens['mean_output']} | "
            f"{tokens['reasoning_reported']}/{tokens['count']} | {_count(tokens['mean_reasoning'])} | "
            f"{_count(tokens['max_reasoning'])} |",
        ]

    lines += ["", "## By mode", "", "| Mode | Passed | Failed | Errors |", "| --- | --- | --- | --- |"]
    for mode, tally in summary["by_mode"].items():
        lines.append(f"| {mode} | {tally['passed']}/{tally['cases']} | {tally['failed']} | {tally['errors']} |")
    lines += ["", "## By category", "", "| Category | Passed | Failed | Errors |", "| --- | --- | --- | --- |"]
    for category, tally in summary["by_category"].items():
        lines.append(f"| {category} | {tally['passed']}/{tally['cases']} | {tally['failed']} | {tally['errors']} |")

    if summary["flags"]:
        lines += ["", "## Flags", "", "| Flag | Severity | Cases | Meaning |", "| --- | --- | --- | --- |"]
        for code, count in summary["flags"].items():
            info = FLAGS[code]
            lines.append(f"| `{code}` | {info.severity} | {count} | {_cell(info.description)} |")

    problems = [case for case in cases if case["status"] != "pass"]
    if problems:
        lines += ["", "## Failures and errors", ""]
        for case in problems:
            lines += [
                f"### `{case['id']}` ({case['mode']}): {case['status']}",
                "",
                f"- Glosses: `{_cell(' '.join(case['glosses']))}`",
                f"- Output: {_cell(case['output']) if case['output'] is not None else '(none)'}",
                f"- Expected (any of): {' / '.join(_cell(ref) for ref in case['references'])}",
            ]
            if case["error"]:
                lines.append(f"- Error: `{case['error']['code']}`: {_cell(case['error']['message'])}")
            for flag in case["flags"]:
                if flag["code"] != "provider_error":
                    lines.append(f"- `{flag['code']}` ({flag['severity']}): {_cell(flag['detail'])}")
            lines.append("")
        lines.pop()

    lines += [
        "",
        "## All cases",
        "",
        "| Case | Mode | Status | Latency | Thinking tokens | Overlap | Flags | Output |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for case in cases:
        flags = ", ".join(f"`{flag['code']}`" for flag in case["flags"]) or "none"
        overlap = "n/a" if case["reference_overlap"] is None else f"{case['reference_overlap']:.2f}"
        usage = case.get("usage")
        thinking = "n/a" if not usage else _count(usage["reasoning_tokens"])
        lines.append(
            f"| `{case['id']}` | {case['mode']} | {case['status']} | {_ms(case['latency_ms'])} | {thinking} | "
            f"{overlap} | {flags} | {_cell(case['output'])} |"
        )
    return "\n".join(lines) + "\n"


# ---------- Files ----------


def report_stem(run: RunInfo) -> str:
    return f"translation-eval-{run.provider}-{run.started_at.astimezone(UTC):%Y%m%dT%H%M%SZ}"


def write_reports(report: dict, out_dir: Path, stem: str, *, secrets: Sequence[str] = ()) -> tuple[Path, Path]:
    """Write ``<stem>.json`` and ``<stem>.md``. Any secret that somehow reached the text is redacted first."""
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{stem}.json"
    md_path = out_dir / f"{stem}.md"
    json_text = redact(json.dumps(report, indent=2, ensure_ascii=False) + "\n", secrets)
    json_path.write_text(json_text, encoding="utf-8")
    md_path.write_text(redact(render_markdown(report), secrets), encoding="utf-8")
    return json_path, md_path
