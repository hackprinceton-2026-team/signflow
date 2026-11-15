"""Deterministic fidelity checks: unit behavior and agreement with the dataset."""

from __future__ import annotations

import pytest

from evals.checks import (
    check_output,
    extract_numbers,
    failing,
    has_negation,
    reference_overlap,
    time_concepts,
)
from evals.dataset import EvalCase, load_dataset
from evals.lexicon import find_phrase

DATASET = load_dataset()
CASES = {case.id: case for case in DATASET.cases}


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


def codes(case: EvalCase, output: str) -> set[str]:
    return {flag.code for flag in failing(check_output(case, output))}


# ---------- The dataset agrees with the checks ----------


@pytest.mark.parametrize(
    ("case_id", "reference"), [(c.id, ref) for c in DATASET.cases for ref in c.references], ids=lambda v: str(v)[:40]
)
def test_every_reference_passes_its_own_case(case_id: str, reference: str):
    assert check_output(CASES[case_id], reference) == []


@pytest.mark.parametrize(
    ("case_id", "index"),
    [(c.id, i) for c in DATASET.cases for i in range(len(c.counterexamples))],
)
def test_every_counterexample_raises_exactly_its_flags(case_id: str, index: int):
    example = CASES[case_id].counterexamples[index]
    assert codes(CASES[case_id], example.output) == set(example.expect_flags)


def test_checks_are_deterministic():
    case = CASES["num-two-pills-daily"]
    outputs = ["I take two aspirin every day.", "I take two pills a day."]
    assert [check_output(case, o) for o in outputs] == [check_output(case, o) for o in outputs]


# ---------- Phrase matching ----------


def test_phrases_match_whole_words_and_prefixes():
    assert find_phrase("pain", "My pain is bad.")
    assert not find_phrase("pain", "I like painting.")
    assert find_phrase("allerg*", "I'm allergic.") and find_phrase("allerg*", "Allergies!")
    assert find_phrase("new york", "NEW-YORK") and find_phrase("new york", "New  York")
    assert not find_phrase("st", "first")


# ---------- Negation ----------


@pytest.mark.parametrize(
    "text",
    ["I don't know.", "I do not know.", "I can't stand.", "I cannot stand.", "I have never smoked.",
     "No allergies.", "Nobody came.", "My child isn’t breathing!", "I have nothing."],
)  # fmt: skip
def test_negation_is_detected(text: str):
    assert has_negation(text)


@pytest.mark.parametrize("text", ["I know.", "Nice to meet you.", "I take my medicine after eating.", "Snow."])
def test_affirmatives_are_not_negated(text: str):
    assert not has_negation(text)


# ---------- Numbers ----------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("I am 25 years old.", [25]),
        ("I'm twenty-five years old.", [25]),
        ("Twenty five", [25]),
        ("one hundred and five people", [105]),
        ("two thousand twenty-six", [2026]),
        ("It costs 1,500 dollars.", [1500]),
        ("My pain is an 8 out of 10.", [8, 10]),
        ("Take 2.5 ml", [2.5]),
        ("at 3:30 p.m.", [3, 30]),
        ("two three", [2, 3]),
        ("No one came, so take this one.", []),
        ("One of them", [1]),
        ("IX-1 POSS-1", []),
        ("a dozen eggs", []),
    ],
)
def test_numbers_are_extracted_as_values(text: str, expected: list[float]):
    assert sorted(extract_numbers(text)) == sorted(float(n) for n in expected)


def test_number_checks_name_what_changed():
    case = make_case(numbers=[25])
    [missing, added] = check_output(case, "I am 52 years old.")
    assert (missing.code, missing.detail) == ("number_missing", "expected 25; found 52")
    assert (added.code, added.detail) == ("number_added", "not signed: 52")
    assert check_output(case, "I am twenty-five.") == []


def test_unsigned_numbers_are_flagged_everywhere():
    assert codes(make_case(), "Hello, I have 2 kids.") == {"number_added"}
    assert codes(make_case(allowed_extra_numbers=[911]), "Call 911.") == set()


# ---------- Time ----------


def test_time_concepts_and_clock_suffixes():
    assert time_concepts("I'll go tomorrow morning at 9 a.m.") == {"tomorrow", "morning", "am"}
    assert time_concepts("3pm tonight") == {"pm", "tonight"}
    assert "am" not in time_concepts("I am here.")
    assert "night" not in time_concepts("tonight")
    assert time_concepts("I take it twice a day") == {"every_day"}


def test_time_conflicts_are_reported_once():
    case = make_case(glosses=["YESTERDAY", "HAPPY"], references=["I was happy yesterday."], times=["yesterday"])
    [missing, conflict] = check_output(case, "I'll be happy tomorrow.")
    assert (missing.code, conflict.code) == ("time_missing", "time_conflict")
    assert "tomorrow" in conflict.detail


def test_unsigned_anchoring_time_is_flagged_but_filler_is_not():
    case = make_case(glosses=["HUNGRY"], references=["I'm hungry."])
    assert codes(case, "I was hungry yesterday.") == {"time_added"}
    assert codes(case, "I'm hungry right now.") == set()
    assert codes(case, "I'm hungry today.") == set()


# ---------- Medical and content ----------


def test_medical_hallucination_is_excused_only_when_a_reference_names_it():
    case = make_case(glosses=["HEAD", "HURT"], references=["My head hurts."])
    assert codes(case, "I have a migraine.") == {"medical_hallucination"}
    assert codes(case, "My head hurts, maybe the flu.") == {"medical_hallucination"}
    named = make_case(glosses=["NEED", "INSULIN"], references=["I need insulin."])
    assert codes(named, "I need insulin.") == set()


def test_missing_terms_list_concepts():
    case = make_case(
        medical_terms=[{"concept": "chest", "any_of": ["chest"]}],
        key_terms=[{"concept": "help", "any_of": ["help"]}],
        forbidden_terms=["police"],
    )
    flags = {flag.code: flag.detail for flag in check_output(case, "Call the police.")}
    assert flags == {
        "medical_term_missing": "missing: chest",
        "key_term_missing": "missing: help",
        "forbidden_term": "contains: police",
    }


# ---------- Format ----------


@pytest.mark.parametrize(
    "output",
    ["Sure! Hello.", "Here's the translation: Hello.", "Translation: Hello.", "The glosses mean hello.",
     "HELLO translates to hello.", "As an AI, I say hello."],
)  # fmt: skip
def test_meta_commentary_is_flagged(output: str):
    assert "meta_commentary" in codes(make_case(), output)


@pytest.mark.parametrize("output", ["THANK-YOU so much.", "IX-1 am fine.", "I'm R-A-I.", "#BACK home", "HELLO!"])
def test_gloss_notation_is_flagged(output: str):
    assert "gloss_leak" in codes(make_case(), output)


def test_ordinary_capitals_are_not_gloss_leaks():
    assert codes(make_case(glosses=["GO", "ER"]), "Hello. I need to go to the ER in the USA.") == set()
    assert codes(make_case(), "I'm well-known, Hi.") == set()


def test_empty_output_short_circuits():
    assert [flag.code for flag in check_output(make_case(numbers=[3], times=["now"]), "   ")] == ["empty_output"]


def test_too_long_is_only_a_warning():
    flags = check_output(make_case(), "Hello. " + "And then some more words were added. " * 4)
    assert [flag.code for flag in flags] == ["too_long"]
    assert flags[0].severity == "warn" and failing(flags) == []


def test_flags_serialize_with_family_and_severity():
    flag = check_output(make_case(negation=True), "Hello.")[0]
    assert flag.to_dict() == {
        "code": "negation_dropped",
        "family": "negation",
        "severity": "fail",
        "detail": "signs are negated; output has no negation",
    }


# ---------- Reference overlap ----------


def test_reference_overlap_is_informational_token_f1():
    refs = ["I don't understand."]
    assert reference_overlap("I do not understand.", refs) == 1.0
    assert reference_overlap("I understand.", refs) == pytest.approx(0.667, abs=1e-3)
    assert reference_overlap("Pizza.", refs) == 0.0
    assert reference_overlap("Where is it?", ["Nope.", "Where is the bathroom?"]) == pytest.approx(0.571, abs=1e-3)
