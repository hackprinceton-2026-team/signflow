"""Deterministic checks: the same output always gets the same flags.

No model, network or randomness is involved. Each check looks for one kind of
meaning change (negation, numbers, time, medical terms, content words) or a
format problem that would be spoken aloud, and reports it as a ``Flag``.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .dataset import EvalCase, TermGroup
from .flags import FLAGS, Family, FlagCode, Severity
from .lexicon import (
    ANCHORING_TIME_CONCEPTS,
    CLOCK_AM,
    CLOCK_PM,
    GLOSS_NOTATION_PATTERNS,
    MEDICAL_HALLUCINATION_TERMS,
    META_COMMENTARY_PATTERNS,
    NEGATION_PATTERN,
    PRONOUN_ONE_AFTER,
    SCALES,
    TENS,
    TIME_CONCEPTS,
    TIME_CONFLICTS,
    UNITS,
    find_phrase,
    normalize,
)

#: Output longer than this many times the longest reference (and over the floor) is flagged ``too_long``.
TOO_LONG_RATIO = 3.0
TOO_LONG_FLOOR_CHARS = 80


@dataclass(frozen=True)
class Flag:
    code: FlagCode
    detail: str

    @property
    def severity(self) -> Severity:
        return FLAGS[self.code].severity

    @property
    def family(self) -> Family:
        return FLAGS[self.code].family

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "family": self.family, "severity": self.severity, "detail": self.detail}


# ---------- Extractors ----------


def has_negation(text: str) -> bool:
    return NEGATION_PATTERN.search(normalize(text)) is not None


def _format_number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def _word_numbers(words: Sequence[str]) -> list[float]:
    """Values of spelled-out numbers: "twenty-five" → 25, "one hundred and five" → 105.

    Adjacent units are separate numbers ("two three" → 2, 3). "one" after a
    determiner ("no one", "this one") is a pronoun, not a number.
    """
    values: list[float] = []
    total = 0
    current = 0
    last: str | None = None  # "unit" | "tens" | "scale" | None

    def flush() -> None:
        nonlocal total, current, last
        if last is not None:
            values.append(float(total + current))
        total = current = 0
        last = None

    for index, word in enumerate(words):
        if word in UNITS:
            if word == "one" and index > 0 and words[index - 1] in PRONOUN_ONE_AFTER:
                flush()
                continue
            if last == "unit" or (last == "tens" and UNITS[word] >= 10):
                flush()
            current += UNITS[word]
            last = "unit"
        elif word in TENS:
            if last in ("unit", "tens"):
                flush()
            current += TENS[word]
            last = "tens"
        elif word in SCALES:
            scale = SCALES[word]
            if scale == 100:
                current = (current or 1) * 100
            else:
                total += (current or 1) * scale
                current = 0
            last = "scale"
        elif word == "and" and last == "scale":
            continue
        else:
            flush()
    flush()
    return values


def extract_numbers(text: str) -> list[float]:
    """Every number in the text, written as digits or words, as values (with repeats)."""
    lowered = normalize(text)
    without_separators = re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", lowered)
    # On-the-hour clock times: "3:00" is the number 3, not 3 and 0. ("3:30" still yields 3 and 30.)
    without_separators = re.sub(r"(?<![\d:])(\d{1,2}):00(?![\d:])", r"\1", without_separators)
    # Digits glued to letters are gloss notation (IX-1, POSS-1), reported as gloss_leak instead.
    digits = [float(match) for match in re.findall(r"(?<![a-z]-)(?<![a-z])\d+(?:\.\d+)?", without_separators)]
    tokens = re.findall(r"[a-z]+(?:'[a-z]+)?", re.sub(r"\d", " ", lowered))
    return digits + _word_numbers(tokens)


def time_concepts(text: str) -> set[str]:
    """Time concepts (``lexicon.TIME_CONCEPTS`` ids plus ``am``/``pm``) the text expresses."""
    lowered = normalize(text)
    found = {concept for concept, phrases in TIME_CONCEPTS.items() if any(find_phrase(p, lowered) for p in phrases)}
    if CLOCK_AM.search(lowered):
        found.add("am")
    if CLOCK_PM.search(lowered):
        found.add("pm")
    return found


def _missing_groups(groups: Iterable[TermGroup], text: str) -> list[str]:
    return [group.concept for group in groups if not any(find_phrase(p, text) for p in group.any_of)]


def _tokens(text: str) -> list[str]:
    text = normalize(text)
    text = re.sub(r"\bcan't\b", "can not", text)
    text = re.sub(r"\bwon't\b", "will not", text)
    text = text.replace("n't", " not").replace("'m", " am").replace("'re", " are").replace("'ve", " have")
    text = text.replace("'ll", " will").replace("'d", " would").replace("'s", " is")
    return re.findall(r"[a-z0-9]+", text)


def reference_overlap(output: str, references: Sequence[str]) -> float:
    """Best token F1 against any reference (0..1). Informational only: never fails a case."""
    produced = Counter(_tokens(output))
    best = 0.0
    for reference in references:
        expected = Counter(_tokens(reference))
        common = sum((produced & expected).values())
        if common:
            precision = common / sum(produced.values())
            recall = common / sum(expected.values())
            best = max(best, 2 * precision * recall / (precision + recall))
    return round(best, 3)


# ---------- Checks ----------


def _check_format(case: EvalCase, output: str) -> list[Flag]:
    flags: list[Flag] = []
    if any(pattern.search(output) for pattern in META_COMMENTARY_PATTERNS):
        flags.append(Flag("meta_commentary", "describes the translation instead of giving it"))

    leaked = {match.group(0) for pattern in GLOSS_NOTATION_PATTERNS for match in pattern.finditer(output)}
    for gloss in case.production_glosses():
        if len(gloss) >= 4 and re.search(rf"(?<![\w-]){re.escape(gloss)}(?![\w-])", output):
            leaked.add(gloss)
    if leaked:
        flags.append(Flag("gloss_leak", "gloss notation in output: " + ", ".join(sorted(leaked))))

    limit = max(TOO_LONG_RATIO * max(len(ref) for ref in case.references), TOO_LONG_FLOOR_CHARS)
    if len(output) > limit:
        flags.append(Flag("too_long", f"{len(output)} chars; limit {int(limit)}"))
    return flags


def _check_negation(case: EvalCase, output: str) -> list[Flag]:
    if case.negation is None:
        return []
    negated = has_negation(output)
    if case.negation and not negated:
        return [Flag("negation_dropped", "signs are negated; output has no negation")]
    if not case.negation and negated:
        return [Flag("negation_added", "signs are affirmative; output is negated")]
    return []


def _check_numbers(case: EvalCase, output: str) -> list[Flag]:
    found = extract_numbers(output)
    found_set = set(found)
    flags: list[Flag] = []
    missing = [n for n in case.numbers if n not in found_set]
    if missing:
        flags.append(
            Flag(
                "number_missing",
                "expected " + ", ".join(map(_format_number, missing)) + f"; found {_numbers_text(found)}",
            )
        )
    allowed = set(case.numbers) | set(case.allowed_extra_numbers)
    added = sorted({n for n in found if n not in allowed})
    if added:
        flags.append(Flag("number_added", "not signed: " + ", ".join(map(_format_number, added))))
    return flags


def _numbers_text(values: Sequence[float]) -> str:
    return ", ".join(map(_format_number, values)) if values else "none"


def _check_time(case: EvalCase, output: str) -> list[Flag]:
    found = time_concepts(output)
    in_references = set().union(*(time_concepts(ref) for ref in case.references))
    required = set(case.times)
    flags: list[Flag] = []

    missing = sorted(required - found)
    if missing:
        flags.append(Flag("time_missing", "missing: " + ", ".join(missing)))

    conflicting_ids = set().union(*(TIME_CONFLICTS.get(concept, frozenset()) for concept in required))
    conflicts = sorted((found & conflicting_ids) - required - in_references)
    if conflicts:
        flags.append(Flag("time_conflict", f"contradicts {', '.join(sorted(required))}: " + ", ".join(conflicts)))

    added = sorted((found & ANCHORING_TIME_CONCEPTS) - required - in_references - set(conflicts))
    if added:
        flags.append(Flag("time_added", "not signed: " + ", ".join(added)))
    return flags


def _check_medical(case: EvalCase, output: str) -> list[Flag]:
    flags: list[Flag] = []
    missing = _missing_groups(case.medical_terms, output)
    if missing:
        flags.append(Flag("medical_term_missing", "missing: " + ", ".join(missing)))
    invented = [
        term.rstrip("*")
        for term in MEDICAL_HALLUCINATION_TERMS
        if find_phrase(term, output) and not any(find_phrase(term, ref) for ref in case.references)
    ]
    if invented:
        flags.append(Flag("medical_hallucination", "not signed: " + ", ".join(invented)))
    return flags


def _check_content(case: EvalCase, output: str) -> list[Flag]:
    flags: list[Flag] = []
    missing = _missing_groups(case.key_terms, output)
    if missing:
        flags.append(Flag("key_term_missing", "missing: " + ", ".join(missing)))
    forbidden = [term for term in case.forbidden_terms if find_phrase(term, output)]
    if forbidden:
        flags.append(Flag("forbidden_term", "contains: " + ", ".join(forbidden)))
    return flags


def check_output(case: EvalCase, output: str) -> list[Flag]:
    """All flags for one translation of one case, in ``FLAGS`` order, at most one per code."""
    if not output.strip():
        return [Flag("empty_output", "no text")]
    flags = [
        *_check_format(case, output),
        *_check_negation(case, output),
        *_check_numbers(case, output),
        *_check_time(case, output),
        *_check_medical(case, output),
        *_check_content(case, output),
    ]
    order = {code: index for index, code in enumerate(FLAGS)}
    return sorted(flags, key=lambda flag: order[flag.code])


def failing(flags: Iterable[Flag]) -> list[Flag]:
    return [flag for flag in flags if flag.severity == "fail"]
