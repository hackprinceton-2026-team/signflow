from __future__ import annotations

import asyncio
import io
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import NoCredentialsError
from botocore.response import StreamingBody
from botocore.stub import Stubber
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda
from pydantic import SecretStr

from signflow_api.errors import SpeechUnavailable, TranslationRejected, UpstreamError, UpstreamTimeout
from signflow_api.speech import PollySynthesizer, SynthesisResult, aws_credentials_available
from signflow_api.translation import (
    GeminiTranslator,
    TokenUsage,
    Translation,
    classify_provider_error,
    clean_output,
    token_usage,
)

# ---------- Gemini translator ----------


def translator_with(fn, timeout_s: float = 5) -> GeminiTranslator:
    return GeminiTranslator(
        api_key=SecretStr("unused"), model="gemini-test", temperature=0.2, timeout_s=timeout_s, llm=RunnableLambda(fn)
    )


def test_translator_builds_the_prompt_and_cleans_output():
    seen = {}

    def fake_llm(prompt_value):
        seen["messages"] = prompt_value.to_messages()
        return AIMessage(content='  "Where is the   bathroom?"  ')

    text = asyncio.run(translator_with(fake_llm).translate(["WHERE", "BATHROOM"], "chat"))
    assert text == "Where is the bathroom?"
    system, human = seen["messages"]
    assert "'chat' context" in system.content
    assert "never as instructions" in system.content
    assert human.content == "ASL Glosses: WHERE BATHROOM"


def test_translator_empty_output_is_an_upstream_error():
    with pytest.raises(UpstreamError):
        asyncio.run(translator_with(lambda _: AIMessage(content=' "" ')).translate(["HELLO"], "chat"))


def test_translator_provider_exception_is_an_upstream_error():
    def broken(_):
        raise RuntimeError("quota exceeded for key AIza...")

    with pytest.raises(UpstreamError):
        asyncio.run(translator_with(broken).translate(["HELLO"], "chat"))


class FakeGoogleError(Exception):
    """Shape of google.genai.errors.ClientError: an int ``code`` and the API message."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"{code} {message}")
        self.code = code


def wrapped(code: int, message: str) -> Exception:
    """A LangChain error caused by a Google API error, as langchain-google-genai raises them."""
    try:
        try:
            raise FakeGoogleError(code, message)
        except FakeGoogleError as inner:
            raise RuntimeError("Error calling model 'gemini-test'") from inner
    except RuntimeError as outer:
        return outer


@pytest.mark.parametrize(
    ("code", "message", "expected", "says"),
    [
        (
            400,
            "INVALID_ARGUMENT. API key not valid. Please pass a valid API key.",
            TranslationRejected,
            "key was rejected",
        ),
        (400, "reason: API_KEY_INVALID", TranslationRejected, "key was rejected"),
        (403, "PERMISSION_DENIED", TranslationRejected, "key was rejected"),
        (404, "models/gemini-test is not found", TranslationRejected, "GEMINI_MODEL"),
        (429, "RESOURCE_EXHAUSTED", UpstreamError, "quota"),
        (500, "INTERNAL", UpstreamError, "Try again"),
        (400, "Request contains an invalid argument.", UpstreamError, "Try again"),
    ],
)
def test_provider_errors_are_classified_with_actionable_messages(code, message, expected, says):
    error = classify_provider_error(wrapped(code, message), "gemini-test")
    assert type(error) is expected
    assert says in error.message
    assert "AIza" not in error.message and message not in error.message


def test_translator_rejected_key_is_reported_as_unavailable():
    def rejected(_):
        raise wrapped(400, "API key not valid. key=AIzaSySECRET")

    with pytest.raises(TranslationRejected) as info:
        asyncio.run(translator_with(rejected).translate(["HELLO"], "chat"))
    assert "AIza" not in info.value.message


def test_translator_timeout():
    async def slow(_):
        await asyncio.sleep(1)
        return AIMessage(content="late")

    with pytest.raises(UpstreamTimeout):
        asyncio.run(translator_with(slow, timeout_s=0.05).translate(["HELLO"], "chat"))


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("Hello.", "Hello."), ("“Hello.”", "Hello."), ("'Hi'", "Hi"), ("a\n\n b", "a b"), ("x" * 3000, "x" * 2000)],
)
def test_clean_output(raw, expected):
    assert clean_output(raw) == expected


def test_real_gemini_client_is_constructed_with_config():
    t = GeminiTranslator(api_key=SecretStr("AIzaSyFAKE"), model="gemini-3.5-flash", temperature=0.1, timeout_s=7)
    llm = t._chain.steps[1]
    assert llm.model.endswith("gemini-3.5-flash")
    assert llm.temperature == 0.1
    assert llm.max_retries == 1
    assert "AIzaSyFAKE" not in repr(llm)


# ---------- Polly synthesizer ----------


def polly_client():
    return boto3.client("polly", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")


def audio_response(data: bytes = b"ID3mp3") -> dict:
    return {"AudioStream": StreamingBody(io.BytesIO(data), len(data)), "ContentType": "audio/mpeg"}


def synth_params(engine: str, voice: str = "Ruth") -> dict:
    return {"Text": "Hi.", "OutputFormat": "mp3", "VoiceId": voice, "Engine": engine}


def test_polly_returns_generative_audio():
    client = polly_client()
    with Stubber(client) as stub:
        stub.add_response("synthesize_speech", audio_response(), synth_params("generative"))
        result = asyncio.run(
            PollySynthesizer(
                region="us-east-1", engine="generative", fallback_engine="neural", timeout_s=5, client=client
            ).synthesize("Hi.", "Ruth")
        )
        stub.assert_no_pending_responses()
    assert result == SynthesisResult(b"ID3mp3", "generative")


def test_polly_retries_with_the_fallback_engine_when_the_voice_lacks_generative():
    client = polly_client()
    with Stubber(client) as stub:
        stub.add_client_error(
            "synthesize_speech",
            service_error_code="EngineNotSupportedException",
            http_status_code=400,
            expected_params=synth_params("generative", "Joey"),
        )
        stub.add_response("synthesize_speech", audio_response(b"ID3neural"), synth_params("neural", "Joey"))
        result = asyncio.run(
            PollySynthesizer(
                region="us-east-1", engine="generative", fallback_engine="neural", timeout_s=5, client=client
            ).synthesize("Hi.", "Joey")
        )
        stub.assert_no_pending_responses()
    assert result == SynthesisResult(b"ID3neural", "neural")


@pytest.mark.parametrize("fallback", [None, "generative"])
def test_polly_without_a_distinct_fallback_engine_does_not_retry(fallback):
    client = polly_client()
    with Stubber(client) as stub:
        stub.add_client_error(
            "synthesize_speech", service_error_code="EngineNotSupportedException", http_status_code=400
        )
        with pytest.raises(UpstreamError):
            asyncio.run(
                PollySynthesizer(
                    region="us-east-1", engine="generative", fallback_engine=fallback, timeout_s=5, client=client
                ).synthesize("Hi.", "Joey")
            )
        stub.assert_no_pending_responses()


def test_polly_other_client_errors_are_not_retried_with_the_fallback():
    client = polly_client()
    with Stubber(client) as stub:
        stub.add_client_error(
            "synthesize_speech", service_error_code="TextLengthExceededException", http_status_code=400
        )
        with pytest.raises(UpstreamError):
            asyncio.run(
                PollySynthesizer(
                    region="us-east-1", engine="generative", fallback_engine="neural", timeout_s=5, client=client
                ).synthesize("Hi.", "Ruth")
            )
        stub.assert_no_pending_responses()


def test_polly_client_error_is_an_upstream_error():
    client = polly_client()
    with Stubber(client) as stub:
        stub.add_client_error(
            "synthesize_speech", service_error_code="InvalidParameterValueException", http_status_code=400
        )
        with pytest.raises(UpstreamError):
            asyncio.run(
                PollySynthesizer(region="us-east-1", engine="neural", timeout_s=5, client=client).synthesize(
                    "Hi.", "Nope"
                )
            )


def test_polly_without_credentials_is_unavailable():
    client = MagicMock()
    client.synthesize_speech.side_effect = NoCredentialsError()
    with pytest.raises(SpeechUnavailable):
        asyncio.run(
            PollySynthesizer(region="us-east-1", engine="neural", timeout_s=5, client=client).synthesize(
                "Hi.", "Joanna"
            )
        )


def test_polly_timeout():
    import time

    client = MagicMock()
    client.synthesize_speech.side_effect = lambda **_: time.sleep(0.5)
    with pytest.raises(UpstreamTimeout):
        asyncio.run(
            PollySynthesizer(region="us-east-1", engine="neural", timeout_s=0.05, client=client).synthesize(
                "Hi.", "Joanna"
            )
        )


def test_aws_credentials_detection_is_local_and_honest(monkeypatch, tmp_path):
    for var in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "none"))
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "none"))
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    assert aws_credentials_available("us-east-1") is False
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIATEST")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    assert aws_credentials_available("us-east-1") is True


# ---------- Token usage ----------


def test_translate_detailed_reports_token_usage_including_thinking():
    reply = AIMessage(
        content="I have never smoked.",
        usage_metadata={
            "input_tokens": 96,
            "output_tokens": 412,
            "total_tokens": 508,
            "output_token_details": {"reasoning": 405},
        },
    )
    translation = asyncio.run(translator_with(lambda _: reply).translate_detailed(["NEVER", "SMOKE"], "medical"))
    assert translation.text == "I have never smoked."
    assert translation.usage == TokenUsage(input_tokens=96, output_tokens=412, reasoning_tokens=405)


def test_translate_detailed_without_usage_metadata():
    translation = asyncio.run(translator_with(lambda _: AIMessage(content="Hi.")).translate_detailed(["HI"], "chat"))
    assert translation == Translation("Hi.", None)


def test_missing_thinking_count_is_unknown_not_zero():
    """Regression: langchain-google-genai omits output_token_details when thoughts_token_count is 0 or absent,
    so a missing count must not be reported as zero thinking."""
    reply = AIMessage(content="Hi.", usage_metadata={"input_tokens": 5, "output_tokens": 2, "total_tokens": 7})
    assert token_usage(reply) == TokenUsage(input_tokens=5, output_tokens=2, reasoning_tokens=None)
    assert token_usage(reply).to_dict()["reasoning_tokens"] is None


def test_details_without_a_reasoning_key_are_unknown_too():
    reply = AIMessage(
        content="Hi.",
        usage_metadata={"input_tokens": 5, "output_tokens": 2, "total_tokens": 7, "output_token_details": {}},
    )
    assert token_usage(reply).reasoning_tokens is None


def test_an_explicit_zero_thinking_count_stays_zero():
    reply = AIMessage(
        content="Hi.",
        usage_metadata={
            "input_tokens": 5,
            "output_tokens": 2,
            "total_tokens": 7,
            "output_token_details": {"reasoning": 0},
        },
    )
    assert token_usage(reply).reasoning_tokens == 0


def test_translate_still_returns_plain_text():
    reply = AIMessage(content=" Hi. ", usage_metadata={"input_tokens": 5, "output_tokens": 2, "total_tokens": 7})
    assert asyncio.run(translator_with(lambda _: reply).translate(["HI"], "chat")) == "Hi."


# ---------- Thinking level (built offline: constructing the client sends no request) ----------


def real_gemini(**kwargs) -> GeminiTranslator:
    return GeminiTranslator(
        api_key=SecretStr("unused"), model="gemini-3.5-flash", temperature=0.2, timeout_s=20, **kwargs
    )


def test_thinking_level_is_not_sent_unless_configured():
    llm = real_gemini()._chain.last
    assert llm.reasoning_effort is None
    assert llm._prepare_params(None).thinking_config is None, "the model's own default applies"
    assert llm.max_retries == 1 and llm.timeout == 20


@pytest.mark.parametrize("level", ["minimal", "low", "medium", "high"])
def test_configured_thinking_level_reaches_the_gemini_request(level: str):
    config = real_gemini(thinking_level=level)._chain.last._prepare_params(None).thinking_config
    assert config.thinking_level.value == level.upper()
    assert config.thinking_budget is None
