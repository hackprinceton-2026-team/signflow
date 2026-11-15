"""The evaluation dataset: synthetic ASL gloss sequences with fidelity expectations.

Cases live in ``evals/cases.json`` and are validated here, including against the
production request schema, so every case is something ``POST /translate`` would
accept.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from signflow_api.schemas import TranslationMode, TranslationRequest

from .flags import FlagCode
from .lexicon import ALL_TIME_CONCEPTS, phrase_pattern

DEFAULT_CASES_PATH = Path(__file__).resolve().parent / "cases.json"

Category = Literal["conversation", "negation", "numbers", "time", "medical", "emergency", "robustness"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class TermGroup(_Strict):
    """A concept the English must express, in any of several wordings."""

    concept: str = Field(min_length=1)
    any_of: list[str] = Field(min_length=1, description="Whole-word phrases; trailing * matches a word prefix.")

    @field_validator("any_of")
    @classmethod
    def _valid_phrases(cls, phrases: list[str]) -> list[str]:
        for phrase in phrases:
            phrase_pattern(phrase)  # raises on an empty phrase
        return phrases


class Counterexample(_Strict):
    """A plausible wrong translation and exactly the ``fail`` flags it must raise."""

    output: str
    expect_flags: list[FlagCode] = Field(min_length=1)
    note: str = ""


class EvalCase(_Strict):
    id: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    category: Category
    mode: TranslationMode
    glosses: list[str] = Field(min_length=1)
    description: str = Field(min_length=1)
    references: list[str] = Field(min_length=1, description="Acceptable English translations.")
    #: True: the English must negate. False: it must not. None: not checked.
    negation: bool | None = None
    #: Numbers the English must contain, as values ("3" and "three" both count).
    numbers: list[float] = []
    #: Numbers the English may contain without being flagged (e.g. the 10 in "8 out of 10").
    allowed_extra_numbers: list[float] = []
    #: Time concepts (see ``lexicon.TIME_CONCEPTS``) the English must contain.
    times: list[str] = []
    medical_terms: list[TermGroup] = []
    key_terms: list[TermGroup] = []
    forbidden_terms: list[str] = []
    counterexamples: list[Counterexample] = []

    @field_validator("times")
    @classmethod
    def _known_time_concepts(cls, times: list[str]) -> list[str]:
        unknown = sorted(set(times) - ALL_TIME_CONCEPTS)
        if unknown:
            raise ValueError(f"unknown time concepts {unknown}; see lexicon.TIME_CONCEPTS")
        return times

    @field_validator("forbidden_terms")
    @classmethod
    def _valid_forbidden(cls, phrases: list[str]) -> list[str]:
        for phrase in phrases:
            phrase_pattern(phrase)
        return phrases

    @model_validator(mode="after")
    def _accepted_by_production_schema(self) -> EvalCase:
        self.request()
        return self

    def request(self) -> TranslationRequest:
        """The exact request ``POST /translate`` would receive for this case."""
        return TranslationRequest(raw_signs=list(self.glosses), mode=self.mode)

    def production_glosses(self) -> list[str]:
        """Glosses as the route hands them to the translator (validated, uppercased)."""
        return [gloss.upper() for gloss in self.request().raw_signs]


class Dataset(_Strict):
    version: int = Field(ge=1)
    description: str
    cases: list[EvalCase] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_ids(self) -> Dataset:
        counts = Counter(case.id for case in self.cases)
        duplicates = sorted(case_id for case_id, count in counts.items() if count > 1)
        if duplicates:
            raise ValueError(f"duplicate case ids: {duplicates}")
        return self

    def select(
        self,
        *,
        ids: list[str] | None = None,
        categories: list[str] | None = None,
        modes: list[str] | None = None,
    ) -> list[EvalCase]:
        """Cases matching every given filter, in dataset order. Unknown ids are an error."""
        if ids:
            unknown = sorted(set(ids) - {case.id for case in self.cases})
            if unknown:
                raise ValueError(f"unknown case ids: {', '.join(unknown)}")
        return [
            case
            for case in self.cases
            if (not ids or case.id in ids)
            and (not categories or case.category in categories)
            and (not modes or case.mode in modes)
        ]


def load_dataset(path: Path = DEFAULT_CASES_PATH) -> Dataset:
    return Dataset.model_validate_json(path.read_text(encoding="utf-8"))


def dataset_fingerprint(path: Path = DEFAULT_CASES_PATH) -> str:
    """SHA-256 of the canonical JSON, so reports from different dataset versions aren't compared blindly."""
    data = json.loads(path.read_text(encoding="utf-8"))
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
