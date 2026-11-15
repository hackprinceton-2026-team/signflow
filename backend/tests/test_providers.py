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

from signflow_api.errors import SpeechUnavailable, UpstreamError, UpstreamTimeout
from signflow_api.speech import PollySynthesizer, SynthesisResult, aws_credentials_available
from signflow_api.translation import GeminiTranslator, clean_output

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
    t = GeminiTranslator(api_key=SecretStr("AIzaSyFAKE"), model="gemini-3.8-flash", temperature=0.1, timeout_s=7)
    llm = t._chain.steps[1]
    assert llm.model.endswith("gemini-3.8-flash")
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
