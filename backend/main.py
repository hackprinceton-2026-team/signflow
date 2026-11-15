import os
import base64
import boto3
import uvicorn
from typing import List, Literal
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

app = FastAPI(title="SignFlow Accessibility Backend")

# Allow frontend requests during hackathon development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. Initialize Gemini LLM (uses GOOGLE_API_KEY from environment)
llm = ChatGoogleGenerativeAI(
    model="gemini-3.8-flash",
    temperature=0.2,
)

# 2. Initialize Amazon Polly client (uses your configured AWS credentials in us-east-1)
polly_client = boto3.client("polly", region_name="us-east-1")


class TranslationRequest(BaseModel):
    raw_signs: List[str] = Field(..., example=["HEADACHE", "SINCE", "YESTERDAY"])
    mode: Literal["chat", "medical", "emergency"] = Field(default="chat")
    voice_id: str = Field(default="Joanna")


class TranslationResponse(BaseModel):
    translated_text: str
    audio_base64: str
    audio_format: str = "mp3"


prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        "You are an expert American Sign Language (ASL) gloss-to-English interpreter for an accessibility app. "
        "Convert the sequence of raw ASL sign glosses into natural, grammatically fluent English. "
        "Adapt tone to the '{mode}' context (e.g., clear and empathetic for medical/emergency, natural for chat). "
        "Return ONLY the final spoken English sentence with no commentary, quotes, or explanations."
    ),
    ("human", "ASL Glosses: {glosses}")
])

translation_chain = prompt | llm | StrOutputParser()


@app.post("/translate", response_model=TranslationResponse)
async def translate_signs(request: TranslationRequest):
    if not request.raw_signs:
        raise HTTPException(status_code=400, detail="raw_signs cannot be empty")

    try:
        # Step 1: Translate ASL glosses to natural English via Gemini
        gloss_string = " ".join(request.raw_signs)
        translated_text = await translation_chain.ainvoke({
            "glosses": gloss_string,
            "mode": request.mode,
        })
        translated_text = translated_text.strip()

        # Step 2: Synthesize speech via Amazon Polly
        polly_response = polly_client.synthesize_speech(
            Text=translated_text,
            OutputFormat="mp3",
            VoiceId=request.voice_id,
            Engine="neural",
        )

        audio_bytes = polly_response["AudioStream"].read()
        audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

        return TranslationResponse(
            translated_text=translated_text,
            audio_base64=audio_b64,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)