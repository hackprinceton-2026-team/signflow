"""Word lists the deterministic checks match against.

All matching is case-insensitive on whole words. A phrase ending in ``*`` matches
any word that starts with it (``allerg*`` matches "allergy" and "allergic").
Lists are deliberately small and explicit: a check that misses a paraphrase is
fixed by adding the paraphrase here or to the case, not by fuzzy matching.
"""

from __future__ import annotations

import re
from functools import lru_cache

# ---------- Phrase matching ----------


@lru_cache(maxsize=1024)
def phrase_pattern(phrase: str) -> re.Pattern[str]:
    """Whole-word, case-insensitive regex for a phrase; trailing ``*`` is a word prefix."""
    text = phrase.strip().lower()
    prefix = text.endswith("*")
    if prefix:
        text = text[:-1]
    if not text:
        raise ValueError("empty phrase")
    body = r"[\s\-]+".join(re.escape(word) for word in re.split(r"[\s\-]+", text))
    tail = r"[\w'-]*" if prefix else r"(?![\w])"
    return re.compile(rf"(?<![\w]){body}{tail}", re.IGNORECASE)


def find_phrase(phrase: str, text: str) -> bool:
    return phrase_pattern(phrase).search(text) is not None


def normalize(text: str) -> str:
    """Lowercase, straight apostrophes, single spaces."""
    text = text.replace("’", "'").replace("‘", "'").replace("–", "-").replace("—", " - ")
    return re.sub(r"\s+", " ", text).strip().lower()


# ---------- Negation ----------

#: Explicit negators plus the n't contraction ("don't", "can't", "isn't").
NEGATION_PATTERN = re.compile(
    r"(?<![\w])(not|no|never|none|nobody|nothing|nowhere|neither|nor|cannot|without|no one|no-one)(?![\w])|n't(?![\w])",
    re.IGNORECASE,
)

# ---------- Numbers ----------

UNITS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
}
TENS = {
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
SCALES = {"hundred": 100, "thousand": 1000}

#: "one" is a pronoun after these words ("no one", "the blue one", "this one").
PRONOUN_ONE_AFTER = {"no", "the", "this", "that", "which", "each", "every", "any", "some", "another", "little"}

# ---------- Time ----------

#: Time concepts a case can require. Each maps to the phrases that express it.
TIME_CONCEPTS: dict[str, tuple[str, ...]] = {
    "yesterday": ("yesterday",),
    "today": ("today",),
    "tomorrow": ("tomorrow",),
    "tonight": ("tonight", "this evening"),
    "now": ("now", "right now", "currently", "at the moment", "immediately"),
    "morning": ("morning*",),
    "afternoon": ("afternoon*",),
    "evening": ("evening*",),
    "night": ("night", "nights", "at night", "overnight"),
    "last_week": ("last week", "past week", "a week ago", "previous week"),
    "next_week": ("next week", "in a week", "coming week"),
    "every_day": ("every day", "everyday", "daily", "each day", "a day", "per day"),
    "since": ("since",),
    "ago": ("ago",),
    "before": ("before",),
    "after": ("after",),
}

#: Clock-time suffixes are matched separately because "am" is also a verb.
CLOCK_AM = re.compile(r"\d\s*a\.?\s?m\.?(?![\w])", re.IGNORECASE)
CLOCK_PM = re.compile(r"\d\s*p\.?\s?m\.?(?![\w])", re.IGNORECASE)

#: If a case requires the key concept, any of these in the output contradicts it.
TIME_CONFLICTS: dict[str, frozenset[str]] = {
    "yesterday": frozenset({"tomorrow", "next_week"}),
    "today": frozenset({"yesterday", "tomorrow"}),
    "tomorrow": frozenset({"yesterday", "last_week", "ago"}),
    "tonight": frozenset({"yesterday", "tomorrow", "morning"}),
    "now": frozenset({"yesterday", "tomorrow", "last_week", "next_week"}),
    "morning": frozenset({"afternoon", "evening", "night", "tonight", "pm"}),
    "afternoon": frozenset({"morning", "night", "am"}),
    "evening": frozenset({"morning", "am"}),
    "night": frozenset({"morning", "afternoon", "am"}),
    "last_week": frozenset({"next_week", "tomorrow"}),
    "next_week": frozenset({"last_week", "yesterday", "ago"}),
    "every_day": frozenset(),
    "since": frozenset(),
    "ago": frozenset({"tomorrow", "next_week"}),
    "before": frozenset({"after"}),
    "after": frozenset({"before"}),
}

#: Concepts that anchor a sentence in time. Adding one that wasn't signed is a
#: fidelity error; "now", "today", "since", "ago", "before" and "after" are left
#: out because fluent English adds them without changing what was said.
ANCHORING_TIME_CONCEPTS = frozenset(
    {
        "yesterday",
        "tomorrow",
        "tonight",
        "morning",
        "afternoon",
        "evening",
        "night",
        "last_week",
        "next_week",
        "every_day",
        "am",
        "pm",
    }
)

#: All concept ids, including the clock suffixes that only have regexes.
ALL_TIME_CONCEPTS = frozenset(TIME_CONCEPTS) | {"am", "pm"}

# ---------- Medical ----------

#: Diagnoses and medications that must not appear unless a reference names them.
#: Symptoms ("pain", "dizzy") are not here: cases require those explicitly.
MEDICAL_HALLUCINATION_TERMS: tuple[str, ...] = (
    "migraine*",
    "concussion*",
    "heart attack",
    "cardiac",
    "stroke",
    "seizure*",
    "epilep*",
    "asthma*",
    "diabet*",
    "cancer*",
    "tumor*",
    "covid*",
    "flu",
    "influenza",
    "pneumonia",
    "infection*",
    "infected",
    "fracture*",
    "appendicitis",
    "overdos*",
    "sepsis",
    "anaphyla*",
    "hypertension",
    "blood pressure",
    "ibuprofen",
    "aspirin",
    "acetaminophen",
    "paracetamol",
    "tylenol",
    "advil",
    "motrin",
    "penicillin",
    "amoxicillin",
    "antibiotic*",
    "insulin",
    "morphine",
    "opioid*",
    "epinephrine",
    "epipen*",
    "inhaler*",
)

# ---------- Format ----------

#: The model describing its work instead of doing it.
META_COMMENTARY_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\s*(sure|certainly|of course|okay, here|here is|here's)\b", re.IGNORECASE),
    re.compile(r"\b(translation|english|interpretation|output)\s*:", re.IGNORECASE),
    re.compile(r"\bglosse?s?\b", re.IGNORECASE),
    re.compile(r"\bas an ai\b", re.IGNORECASE),
    re.compile(r"\b(this|the) (sentence|phrase|signs?) (means|translates)\b", re.IGNORECASE),
    re.compile(r"\btranslates (to|as)\b", re.IGNORECASE),
)

#: Gloss notation that should never reach English: hyphenated all-caps compounds
#: (THANK-YOU, NEW-YORK, IX-1), fingerspelling (R-A-I), and #-marked loan signs.
GLOSS_NOTATION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?<![\w-])[A-Z]{2,}(?:-[A-Z0-9]+)+(?![\w-])"),
    re.compile(r"(?<![\w-])IX(?:-[A-Za-z0-9]+)?(?![\w-])"),
    re.compile(r"(?<![\w-])[A-Z](?:-[A-Z]){2,}(?![\w-])"),
    re.compile(r"#[A-Z]{2,}"),
)
