from __future__ import annotations

import json

import pytest

from scripts.export_openapi import OUTPUT, render
from signflow_api import schemas


def test_committed_openapi_matches_the_code():
    assert OUTPUT.read_text(encoding="utf-8") == render(), "Run: python -m scripts.export_openapi"


@pytest.fixture(scope="module")
def doc() -> dict:
    return json.loads(render())


def test_translation_response_carries_no_audio(doc):
    props = doc["components"]["schemas"]["TranslationResponse"]["properties"]
    assert set(props) == {"translated_text", "mode", "model"}


@pytest.mark.parametrize("path", ["/translate", "/speak"])
def test_errors_are_documented_with_the_error_shape(doc, path):
    responses = doc["paths"][path]["post"]["responses"]
    for status in ("422", "502", "503", "504"):
        ref = responses[status]["content"]["application/json"]["schema"]["$ref"]
        assert ref == "#/components/schemas/ErrorResponse"


def test_operation_ids_are_stable(doc):
    ids = {op["operationId"] for path in doc["paths"].values() for op in path.values()}
    assert ids == {"health", "translate", "speak"}


@pytest.mark.parametrize(
    "model",
    [
        schemas.TranslationRequest,
        schemas.TranslationResponse,
        schemas.SpeechRequest,
        schemas.SpeechResponse,
        schemas.HealthResponse,
        schemas.ErrorResponse,
    ],
)
def test_schema_examples_are_valid(doc, model):
    examples = doc["components"]["schemas"][model.__name__]["examples"]
    assert examples
    for example in examples:
        model.model_validate(example)
