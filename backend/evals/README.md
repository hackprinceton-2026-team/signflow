# Translation evaluation (`backend/evals/`)

A repeatable quality check for ASL gloss → English translation. It runs a fixed set of synthetic gloss sequences through a translator and scores each English output with **deterministic checks** for the mistakes that matter most in an accessibility app: a dropped "not", a changed number, a flipped "yesterday/tomorrow", an invented diagnosis.

It does not change `POST /translate`. The live mode wraps the production `GeminiTranslator` and feeds it the same validated, uppercased glosses the route does, then applies the same output cleanup, so scores reflect what the app would show.

## Quick start

From `backend/` with the dev venv active:

```bash
python -m evals                               # offline: score the reference answers (sanity check)
python -m evals --responses out.json          # offline: re-score saved outputs
python -m evals --live                        # real Gemini calls (needs GOOGLE_API_KEY)
python -m evals --live --case num-age-25      # one live call
```

Each run prints one line per case and a summary, and writes a JSON and a Markdown report to `evals/out/` (gitignored). Exit status: `0` if every case passed, `1` if any failed or errored, `2` for usage or configuration problems.

| Option | Meaning |
| --- | --- |
| `--responses FILE` | Re-score saved outputs offline: a report from an earlier run, or `{"case-id": "output"}` (or `{"case-id": {"output": "...", "latency_ms": 640}}`). Recorded latencies are kept. |
| `--live` | Call the real Gemini API. Mutually exclusive with `--responses`. |
| `--model NAME` | With `--live`: use this model instead of `GEMINI_MODEL`. |
| `--delay-s S` | With `--live`: pause between calls (free-tier keys are rate limited). |
| `--case ID`, `--category NAME`, `--mode MODE` | Run a subset. Each is repeatable; filters combine. |
| `--latency-budget-ms MS` | Flag slower translations (default 3000). A warning, not a failure. |
| `--out-dir DIR`, `--no-write` | Where reports go, or skip writing them. |
| `--cases FILE` | Use another dataset file. |

## Offline vs live

| | Offline (default, `--responses`) | Live (`--live`) |
| --- | --- | --- |
| Network | None | Gemini API only |
| Credentials | None | `GOOGLE_API_KEY` from `backend/.env` or the environment |
| Cost | Free | One API call per case (25 for the full set) |
| Latency numbers | Harness overhead (or recorded values) | Real end-to-end translation latency |
| Determinism | Fully deterministic | Model output can vary between runs |

A useful loop: run `--live` once, then iterate on checks or cases with `--responses evals/out/<that report>.json` without spending quota.

**Safety of live runs.** Nothing calls Gemini unless `--live` is on the command line. A missing key exits with instructions instead of attempting calls. The key is passed only to the translator. It is never printed or written to a report, and any accidental occurrence in report text is replaced with `[REDACTED]` before the file is written. Provider errors are recorded with the API's fixed, user-safe messages. Unexpected exceptions are reported by type only. No AWS or Polly code is involved.

## The dataset (`cases.json`)

25 synthetic cases: 9 chat, 12 medical, 4 emergency.

| Category | Cases | What it probes |
| --- | --- | --- |
| conversation | 3 | Greetings, WH-questions, fingerspelled names (`R-A-I` → "Rai") |
| negation | 5 | `NOT`, `NEVER`, sentence-final `NONE`, `CAN'T`; including emergencies |
| numbers | 5 | Numeral and word glosses, dose counts, pain scale, a street address |
| time | 5 | Topicalized time signs, `SINCE`, clock time (`TIME 3`), `LAST-WEEK`, number incorporation (`THREE-DAY`) |
| medical | 5 | Symptoms vs diagnoses, fingerspelled drugs, allergy polarity, before/after a dose |
| emergency | 1 | "Call an ambulance" must not become "call the police" |
| robustness | 1 | Signs that read like a prompt injection must be translated, not obeyed or refused |

**Limitations, honestly stated.** The glosses were written by the team for regression testing. They were not collected from signers or reviewed by Deaf ASL users. Their word order is simplified, English-like ASL, and they cannot encode non-manual markers (a headshake negation, raised brows for a question). A high score means the model preserves meaning on these cases. It does not mean real-world translation accuracy. Have fluent signers review and extend the set before relying on it for decisions.

Each case has:

- `glosses`, `mode`, and `references` (acceptable English, any of which is a correct answer)
- `negation`: `true` (must negate), `false` (must not), or omitted (not checked)
- `numbers` that must appear, and `allowed_extra_numbers` that may (the 10 in "8 out of 10")
- `times`: time concepts that must appear (ids from `lexicon.TIME_CONCEPTS`)
- `medical_terms` and `key_terms`: concepts that must appear, each with any-of wordings
- `forbidden_terms`: wrong substitutions this case rules out
- `counterexamples`: plausible wrong translations and **exactly** the flags each must raise

Every case is validated against the production `TranslationRequest` schema, so it is a request the API would accept.

## Checks and flags

All checks are deterministic: case-insensitive whole-word matching against explicit word lists (`lexicon.py`), no model and no randomness. A phrase ending in `*` matches a word prefix (`allerg*` matches "allergic" and "allergies").

| Flag | Severity | Raised when |
| --- | --- | --- |
| `negation_dropped` / `negation_added` | fail | The polarity of the English doesn't match the signs |
| `number_missing` / `number_added` | fail | A signed number is missing or changed, or an unsigned number appears (digits or words: "25", "twenty-five"; an on-the-hour time like "3:00" counts as 3) |
| `time_missing` | fail | A required time concept is absent |
| `time_conflict` | fail | A contradicting time appears (yesterday→tomorrow, before→after, morning→night) |
| `time_added` | fail | An anchoring time (yesterday, tomorrow, tonight, every day, a.m./p.m., …) appears that no reference has. Filler like "now" and "today" is allowed. |
| `medical_term_missing` | fail | A signed symptom, condition or medication is missing |
| `medical_hallucination` | fail | A diagnosis or medication (migraine, heart attack, aspirin, …) appears that no reference names |
| `key_term_missing` / `forbidden_term` | fail | A key content word is missing, or a ruled-out term appears |
| `meta_commentary` | fail | "Here is the translation:", "gloss", "As an AI" |
| `gloss_leak` | fail | Gloss notation reached English: `IX-1`, `THANK-YOU`, `R-A-I`, `#BACK`, or a 4+ letter gloss of the case in all caps |
| `empty_output` | fail | No text |
| `provider_error` | fail | The translator returned an error (the case's status is `error`) |
| `too_long` | warn | Over 3× the longest reference (and over 80 characters) |
| `latency_over_budget` | warn | Slower than `--latency-budget-ms` |

A case **passes** when it has no `fail` flag. Reports also give each output's best token-F1 overlap with the references. This number is informational and never fails a case.

The tests pin that every reference passes its own case and every counterexample raises exactly its declared flags, so a change to a check or a word list that breaks either one shows up immediately.

## Reports

`translation-eval-<provider>-<UTC timestamp>.json`:

```jsonc
{
  "schema_version": 1,
  "run": {
    "provider": "gemini", "model": "gemini-3.5-flash", "live": true,
    "started_at": "…Z", "finished_at": "…Z", "duration_s": 21.4,
    "prompt_sha256": "…",            // fingerprint of the production prompt
    "dataset": { "path": "evals/cases.json", "version": 1, "sha256": "…", "cases_total": 25 },
    "filters": {}, "latency_budget_ms": 3000, "settings": { "temperature": 0.2, "timeout_s": 20 }
  },
  "summary": {
    "cases": 25, "passed": 23, "failed": 2, "errors": 0, "pass_rate": 0.92,
    "flags": { "time_added": 1, "negation_dropped": 1 },
    "fidelity": { "negation": { "checked": 25, "flagged": 1, "pass_rate": 0.96 }, "numbers": {…}, "time": {…}, "medical": {…}, "content": {…} },
    "by_mode": {…}, "by_category": {…},
    "latency_ms": { "count": 25, "min": …, "mean": …, "p50": …, "p90": …, "p95": …, "max": … },
    "latency_over_budget": 0, "mean_reference_overlap": 0.81
  },
  "cases": [ { "id", "category", "mode", "glosses", "status", "output", "references",
               "latency_ms", "reference_overlap", "flags": [{ "code", "family", "severity", "detail" }], "error" } ]
}
```

The Markdown report has the same content for people: run details, fidelity and latency tables, results by mode and category, each failure with its glosses, output, expected references and flags, and a table of all cases.

Compare runs only when `dataset.sha256` matches. `prompt_sha256` tells you whether the production prompt changed between them. Latency percentiles use the nearest-rank method over successful translations only.

## Adding or changing a case

1. Add the case to `cases.json` with at least one reference and one counterexample.
2. Run `python -m pytest tests/test_eval_dataset.py tests/test_eval_checks.py`. If a correct reference is flagged, add the wording to the case (or to `lexicon.py` if it's general). If a counterexample raises a flag you didn't expect, decide whether the check or the expectation is wrong.
3. Keep the set at 20–25 cases (a test enforces it). Replace weak cases instead of piling on.

## Layout

```
evals/
  cases.json    the dataset
  dataset.py    case schema and loading (validated against the production request schema)
  flags.py      flag codes, families and severities
  lexicon.py    word lists: negators, number words, time concepts, medical terms, gloss notation
  checks.py     the deterministic checks
  runner.py     responders (reference, recorded, translator), timing, per-case results
  report.py     summary statistics, JSON and Markdown reports
  live.py       opt-in Gemini setup and redaction
  cli.py        python -m evals
tests/test_eval_*.py
```
