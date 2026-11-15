"""Run cases through a responder, time each one, and score the output.

A *responder* turns a case into English. Offline responders return canned text
(the case's own reference, or outputs recorded from an earlier run); the live
responder wraps the production translator. Inputs and outputs go through the
same validation and cleanup as ``POST /translate``, so scores reflect what the
app would show the user.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from signflow_api.errors import ApiError
from signflow_api.translation import TokenUsage, Translator, clean_output

from .checks import Flag, check_output, failing, reference_overlap
from .dataset import EvalCase

Status = Literal["pass", "fail", "error"]

DEFAULT_LATENCY_BUDGET_MS = 3000.0


@dataclass(frozen=True)
class Reply:
    """A responder's answer. ``latency_ms`` overrides the measured time (recorded runs)."""

    text: str
    latency_ms: float | None = None
    #: Token counts reported by the provider (live runs, or recorded from one).
    usage: TokenUsage | None = None


Responder = Callable[[EvalCase], Awaitable[Reply]]


class MissingResponse(Exception):
    """A recorded run has no output for this case."""


@dataclass
class CaseResult:
    case: EvalCase
    output: str | None
    latency_ms: float | None
    flags: list[Flag] = field(default_factory=list)
    error: dict[str, str] | None = None
    overlap: float | None = None
    usage: TokenUsage | None = None

    @property
    def status(self) -> Status:
        if self.error is not None:
            return "error"
        return "fail" if failing(self.flags) else "pass"

    def to_dict(self) -> dict:
        return {
            "id": self.case.id,
            "category": self.case.category,
            "mode": self.case.mode,
            "glosses": self.case.production_glosses(),
            "status": self.status,
            "output": self.output,
            "references": list(self.case.references),
            "latency_ms": None if self.latency_ms is None else round(self.latency_ms, 1),
            "reference_overlap": self.overlap,
            "flags": [flag.to_dict() for flag in self.flags],
            "error": self.error,
            "usage": None if self.usage is None else self.usage.to_dict(),
        }


# ---------- Responders ----------


def reference_responder() -> Responder:
    """Answers every case with its first reference: a sanity check of the dataset and checks."""

    async def respond(case: EvalCase) -> Reply:
        return Reply(case.references[0])

    return respond


def recorded_responder(replies: dict[str, Reply]) -> Responder:
    """Answers with outputs saved earlier, so a live run can be re-scored offline."""

    async def respond(case: EvalCase) -> Reply:
        if case.id not in replies:
            raise MissingResponse(case.id)
        return replies[case.id]

    return respond


def translator_responder(translator: Translator) -> Responder:
    """Calls a production ``Translator`` exactly as ``POST /translate`` does.

    When the translator can report token usage (``GeminiTranslator.translate_detailed``),
    it is recorded too: the same request, with nothing added to it.
    """
    detailed = getattr(translator, "translate_detailed", None)

    async def respond(case: EvalCase) -> Reply:
        if detailed is not None:
            translation = await detailed(case.production_glosses(), case.mode)
            return Reply(translation.text, usage=translation.usage)
        return Reply(await translator.translate(case.production_glosses(), case.mode))

    return respond


@dataclass(frozen=True)
class Recorded:
    replies: dict[str, Reply]
    #: Model named by the source report, when the file is a report from ``python -m evals``.
    model: str | None = None


def _recorded_usage(value: object) -> TokenUsage | None:
    """Token usage saved in a report, when present and well formed (older reports have none)."""
    if not isinstance(value, dict):
        return None

    def count(item: object) -> bool:
        return isinstance(item, int) and not isinstance(item, bool) and item >= 0

    input_tokens, output_tokens = value.get("input_tokens"), value.get("output_tokens")
    reasoning = value.get("reasoning_tokens")
    if not (count(input_tokens) and count(output_tokens) and (reasoning is None or count(reasoning))):
        return None
    return TokenUsage(input_tokens, output_tokens, reasoning)  # type: ignore[arg-type]


def load_recorded(path: Path) -> Recorded:
    """Read outputs to re-score: a report written by this tool, or a plain JSON object
    mapping case id to output text (or to ``{"output": ..., "latency_ms": ...}``)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("cases"), list):
        replies = {
            entry["id"]: Reply(entry["output"], entry.get("latency_ms"), _recorded_usage(entry.get("usage")))
            for entry in data["cases"]
            if isinstance(entry, dict) and isinstance(entry.get("output"), str)
        }
        model = data.get("run", {}).get("model") if isinstance(data.get("run"), dict) else None
        return Recorded(replies, model if isinstance(model, str) else None)
    if not isinstance(data, dict):
        raise ValueError("responses must be a JSON object keyed by case id, or a report from python -m evals")
    replies = {}
    for case_id, value in data.items():
        if isinstance(value, str):
            replies[case_id] = Reply(value)
        elif isinstance(value, dict) and isinstance(value.get("output"), str):
            latency = value.get("latency_ms")
            if latency is not None and not isinstance(latency, int | float):
                raise ValueError(f"{case_id}: latency_ms must be a number")
            replies[case_id] = Reply(value["output"], None if latency is None else float(latency))
        else:
            raise ValueError(f"{case_id}: expected a string or an object with an 'output' string")
    return Recorded(replies)


# ---------- Running ----------


def _error_of(exc: BaseException) -> dict[str, str]:
    """A safe description of a failure. API errors already carry user-safe messages;
    anything else is reported by type only, since its text could include request details."""
    if isinstance(exc, ApiError):
        return {"code": exc.code, "message": exc.message}
    if isinstance(exc, MissingResponse):
        return {"code": "missing_response", "message": "No recorded output for this case."}
    return {"code": "internal_error", "message": f"Unexpected {type(exc).__name__}."}


async def run_case(
    case: EvalCase,
    respond: Responder,
    *,
    latency_budget_ms: float = DEFAULT_LATENCY_BUDGET_MS,
    clock: Callable[[], float] = time.perf_counter,
) -> CaseResult:
    started = clock()
    try:
        reply = await respond(case)
    except Exception as exc:  # noqa: BLE001 - one failing case must not stop the run; recorded as an error
        elapsed = (clock() - started) * 1000
        error = _error_of(exc)
        return CaseResult(case, None, elapsed, [Flag("provider_error", error["code"])], error)
    elapsed = reply.latency_ms if reply.latency_ms is not None else (clock() - started) * 1000

    output = clean_output(reply.text)
    flags = check_output(case, output)
    if elapsed > latency_budget_ms:
        flags.append(Flag("latency_over_budget", f"{elapsed:.0f} ms > {latency_budget_ms:.0f} ms"))
    return CaseResult(case, output, elapsed, flags, None, reference_overlap(output, case.references), reply.usage)


async def run_cases(
    cases: Sequence[EvalCase],
    respond: Responder,
    *,
    latency_budget_ms: float = DEFAULT_LATENCY_BUDGET_MS,
    delay_s: float = 0.0,
    clock: Callable[[], float] = time.perf_counter,
    on_result: Callable[[CaseResult], None] | None = None,
) -> list[CaseResult]:
    """Run cases one at a time (so latencies don't interfere), optionally pausing between them."""
    results: list[CaseResult] = []
    for index, case in enumerate(cases):
        if index and delay_s > 0:
            await asyncio.sleep(delay_s)
        result = await run_case(case, respond, latency_budget_ms=latency_budget_ms, clock=clock)
        results.append(result)
        if on_result is not None:
            on_result(result)
    return results
