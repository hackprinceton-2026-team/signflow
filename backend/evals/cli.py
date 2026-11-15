"""Command line: ``python -m evals`` from ``backend/``.

Offline by default: the cases' reference answers, or outputs recorded earlier
(``--responses``). Real Gemini calls happen only with ``--live``.

Exit status: 0 if every case passed, 1 if any case failed or errored, 2 for
usage or configuration problems.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO

from signflow_api.config import BACKEND_DIR

from . import live
from .dataset import DEFAULT_CASES_PATH, Dataset, EvalCase, dataset_fingerprint, load_dataset
from .report import RunInfo, build_report, passed, report_stem, write_reports
from .runner import (
    DEFAULT_LATENCY_BUDGET_MS,
    CaseResult,
    Responder,
    load_recorded,
    recorded_responder,
    reference_responder,
    run_cases,
    translator_responder,
)

DEFAULT_OUT_DIR = BACKEND_DIR / "evals" / "out"

EXIT_OK, EXIT_FAILURES, EXIT_USAGE = 0, 1, 2


class UsageError(Exception):
    """A problem with how the tool was invoked or configured (exit 2)."""


@dataclass(frozen=True)
class Source:
    provider: str
    model: str
    live: bool
    respond: Responder
    settings: dict[str, object] = field(default_factory=dict)
    secrets: tuple[str, ...] = field(default=(), repr=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m evals",
        description=(
            "Evaluate ASL gloss -> English translation on synthetic cases with deterministic checks. "
            "Offline by default: no network, no credentials."
        ),
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--responses",
        type=Path,
        metavar="FILE",
        help="re-score saved outputs offline: a report JSON from an earlier run, or {case_id: output}",
    )
    source.add_argument(
        "--live",
        action="store_true",
        help="call the real Gemini API with the production translator (uses GOOGLE_API_KEY and quota)",
    )
    parser.add_argument("--model", metavar="NAME", help="with --live: Gemini model to use instead of GEMINI_MODEL")
    parser.add_argument(
        "--delay-s",
        type=float,
        default=0.0,
        metavar="S",
        help="with --live: pause between calls to stay under rate limits (default 0)",
    )
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES_PATH, metavar="FILE", help="dataset JSON")
    parser.add_argument("--case", action="append", dest="ids", metavar="ID", help="only this case (repeatable)")
    parser.add_argument("--category", action="append", dest="categories", metavar="NAME", help="only this category")
    parser.add_argument(
        "--mode", action="append", dest="modes", choices=["chat", "medical", "emergency"], help="only this mode"
    )
    parser.add_argument(
        "--latency-budget-ms",
        type=float,
        default=DEFAULT_LATENCY_BUDGET_MS,
        metavar="MS",
        help=f"flag translations slower than this (default {DEFAULT_LATENCY_BUDGET_MS:.0f})",
    )
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, metavar="DIR", help="where reports go")
    parser.add_argument("--no-write", action="store_true", help="print the summary only; write no report files")
    return parser


def _progress(stream: TextIO) -> Callable[[CaseResult], None]:
    def show(result: CaseResult) -> None:
        codes = ", ".join(flag.code for flag in result.flags)
        latency = "" if result.latency_ms is None else f" {result.latency_ms:7.0f} ms"
        suffix = f"  [{codes}]" if codes else ""
        print(f"  {result.status.upper():5}{latency}  {result.case.id}{suffix}", file=stream)

    return show


def _select(args: argparse.Namespace) -> tuple[Dataset, list[EvalCase]]:
    dataset = load_dataset(args.cases)
    try:
        cases = dataset.select(ids=args.ids, categories=args.categories, modes=args.modes)
    except ValueError as exc:
        raise UsageError(str(exc)) from exc
    if not cases:
        raise UsageError("no cases match the filters")
    return dataset, cases


def _source(args: argparse.Namespace) -> Source:
    if not args.live and args.model is not None:
        raise UsageError("--model only applies with --live")
    if args.delay_s < 0:
        raise UsageError("--delay-s must be zero or more")
    if args.live:
        try:
            setup = live.build_live_translator(live.load_settings(), model=args.model)
        except live.LiveUnavailable as exc:
            raise UsageError(str(exc)) from exc
        return Source(
            "gemini", setup.model, True, translator_responder(setup.translator), setup.settings, setup.secrets
        )
    if args.responses is not None:
        try:
            recorded = load_recorded(args.responses)
        except (OSError, ValueError) as exc:
            raise UsageError(f"cannot read --responses: {exc}") from exc
        return Source("recorded", recorded.model or "recorded", False, recorded_responder(recorded.replies))
    return Source("reference", "reference-answers", False, reference_responder())


def main(argv: Sequence[str] | None = None, *, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    args = build_parser().parse_args(argv)
    try:
        dataset, cases = _select(args)
        source = _source(args)
    except UsageError as exc:
        print(f"error: {exc}", file=stderr)
        return EXIT_USAGE

    if source.live:
        print(
            f"LIVE: {len(cases)} real Gemini API call(s) to {source.model}. This uses your API quota.",
            file=stderr,
        )
    else:
        print(f"Evaluating {len(cases)} case(s) with {source.provider} ({source.model}), offline.", file=stdout)

    started = datetime.now(UTC)
    results = asyncio.run(
        run_cases(
            cases,
            source.respond,
            latency_budget_ms=args.latency_budget_ms,
            delay_s=args.delay_s if source.live else 0.0,
            on_result=_progress(stdout),
        )
    )
    run = RunInfo(
        provider=source.provider,
        model=source.model,
        live=source.live,
        dataset_path=_display_path(args.cases),
        dataset_version=dataset.version,
        dataset_sha256=dataset_fingerprint(args.cases),
        cases_total=len(dataset.cases),
        latency_budget_ms=args.latency_budget_ms,
        started_at=started,
        finished_at=datetime.now(UTC),
        filters={"case": args.ids or [], "category": args.categories or [], "mode": args.modes or []},
        settings=source.settings,
    )
    report = build_report(results, run)
    _print_summary(report, stdout)
    if not args.no_write:
        json_path, md_path = write_reports(report, args.out_dir, report_stem(run), secrets=source.secrets)
        print(f"Reports: {_display_path(json_path)}\n         {_display_path(md_path)}", file=stdout)
    return EXIT_OK if passed(report) else EXIT_FAILURES


def _display_path(path: Path) -> str:
    """Paths relative to backend/ when possible, so reports don't embed home directories."""
    try:
        return str(path.resolve().relative_to(BACKEND_DIR))
    except ValueError:
        return path.name


def _print_summary(report: dict, stream: TextIO) -> None:
    summary = report["summary"]
    latency = summary["latency_ms"]
    fidelity = ", ".join(f"{family} {stats['flagged']}" for family, stats in summary["fidelity"].items())
    print(
        f"\n{'PASS' if passed(report) else 'FAIL'}: {summary['passed']}/{summary['cases']} passed, "
        f"{summary['failed']} failed, {summary['errors']} errors",
        file=stream,
    )
    print(f"Cases flagged by check: {fidelity}", file=stream)
    if latency["count"]:
        print(
            f"Latency: p50 {latency['p50']:.0f} ms, p95 {latency['p95']:.0f} ms, max {latency['max']:.0f} ms "
            f"({summary['latency_over_budget']} over budget)",
            file=stream,
        )
