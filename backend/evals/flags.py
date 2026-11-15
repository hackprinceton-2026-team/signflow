"""The vocabulary of problems an evaluation can report.

Every flag has a stable code (used in the dataset's counterexamples, in reports,
and in tests), a family (which kind of fidelity it measures) and a severity:

- ``fail``: the translation changes or invents meaning, or would be spoken
  aloud in a broken form. Any ``fail`` flag fails the case.
- ``warn``: worth looking at, but not wrong on its own (long output, slow).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Severity = Literal["fail", "warn"]
Family = Literal["format", "negation", "numbers", "time", "medical", "content", "latency", "provider"]

FlagCode = Literal[
    "empty_output",
    "meta_commentary",
    "gloss_leak",
    "too_long",
    "negation_dropped",
    "negation_added",
    "number_missing",
    "number_added",
    "time_missing",
    "time_conflict",
    "time_added",
    "medical_term_missing",
    "medical_hallucination",
    "key_term_missing",
    "forbidden_term",
    "latency_over_budget",
    "provider_error",
]


@dataclass(frozen=True)
class FlagInfo:
    family: Family
    severity: Severity
    description: str


FLAGS: dict[FlagCode, FlagInfo] = {
    "empty_output": FlagInfo("format", "fail", "The translation is empty."),
    "meta_commentary": FlagInfo(
        "format", "fail", "The output talks about the task ('Here is the translation', 'gloss') instead of translating."
    ),
    "gloss_leak": FlagInfo(
        "format", "fail", "Raw gloss notation (IX-1, THANK-YOU, R-A-I, an all-caps gloss) leaked into the English."
    ),
    "too_long": FlagInfo("format", "warn", "Much longer than any reference; the model may be adding content."),
    "negation_dropped": FlagInfo("negation", "fail", "The signs are negated but the English is affirmative."),
    "negation_added": FlagInfo("negation", "fail", "The signs are affirmative but the English negates them."),
    "number_missing": FlagInfo("numbers", "fail", "A signed number is missing or changed."),
    "number_added": FlagInfo("numbers", "fail", "The English contains a number that was not signed."),
    "time_missing": FlagInfo("time", "fail", "A signed time reference (yesterday, every day, after…) is missing."),
    "time_conflict": FlagInfo(
        "time", "fail", "The English contains a time reference that contradicts the signed one (yesterday→tomorrow)."
    ),
    "time_added": FlagInfo("time", "fail", "The English anchors the sentence to a time that was not signed."),
    "medical_term_missing": FlagInfo("medical", "fail", "A signed symptom, condition or medication is missing."),
    "medical_hallucination": FlagInfo(
        "medical", "fail", "The English names a diagnosis or medication that was not signed."
    ),
    "key_term_missing": FlagInfo("content", "fail", "A key content word (who, what, where) is missing."),
    "forbidden_term": FlagInfo("content", "fail", "The English contains a term this case specifically rules out."),
    "latency_over_budget": FlagInfo("latency", "warn", "The translation took longer than the latency budget."),
    "provider_error": FlagInfo("provider", "fail", "The translator returned an error instead of a translation."),
}

#: Families that measure meaning preservation, reported separately in summaries.
FIDELITY_FAMILIES: tuple[Family, ...] = ("negation", "numbers", "time", "medical", "content")
