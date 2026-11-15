# backend/

**Owner: Muhammad Fardeen** (backend and AI engineering)

**Original author: Muhammad Fardeen Ahsan**, who built this FastAPI backend and owned backend engineering.

The FastAPI service between the SignFlow desktop app and the AI providers: ASL gloss → English translation (Gemini, through LangChain), and speech for confirmed text (Amazon Polly).

## Run it

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt      # or requirements.txt for runtime only
cp .env.example .env                     # then add your GOOGLE_API_KEY
uvicorn main:app --reload                # http://127.0.0.1:8000  ·  docs at /docs
```

The server starts without credentials. `/health` reports what is configured, and the endpoints that need a missing credential return a clear `503`.

## Configuration and credentials

All settings are environment variables, optionally in `backend/.env` (gitignored). Every setting is documented in [`.env.example`](.env.example).

| Setting                      | Default                                  | Notes                                           |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `GOOGLE_API_KEY`             | (none)                                   | Required for `/translate`. Never logged or returned. A rejected key returns `503 translation_unavailable` with a clear message, and `/health` then reports translation `not_configured`. |
| `GEMINI_MODEL`               | `gemini-3.5-flash`                       |                                                 |
| `GEMINI_THINKING_LEVEL`      | (empty: model default)                   | `minimal`, `low`, `medium` or `high`. Lower can be faster. Measure quality with `python -m evals` before changing it. |
| `AWS_REGION`, `POLLY_ENGINE`, `POLLY_DEFAULT_VOICE` | `us-east-1`, `generative`, `Ruth` | Polly Generative is the most human-like engine; `Danielle` and `Matthew` are the other recommended voices. AWS credentials come from the standard AWS chain (`aws configure`, `AWS_PROFILE`, SSO, env vars), never from this app's config. |
| `POLLY_FALLBACK_ENGINE`      | `neural`                                 | Retried once if the requested voice doesn't support `POLLY_ENGINE`. Empty disables it. |
| `CORS_ORIGINS`               | `app://signflow,http://localhost:5173`   | Exact origins; `*` is rejected.                 |
| `HOST` / `PORT`              | `127.0.0.1` / `8000`                     | Localhost only by default.                      |

## API

| Endpoint          | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `GET /health`     | Liveness, whether translation and speech are configured, and the default voice and engine |
| `POST /translate` | `{ raw_signs: ["HELLO", …], mode: "chat" \| "medical" \| "emergency" }` → `{ translated_text, mode, model }`. **Text only.** |
| `POST /speak`     | `{ text, voice_id? }` → `{ audio_base64, audio_format: "mp3", voice_id, engine }`. `engine` is what actually produced the audio (`generative`, or the fallback). |

**No speech before confirmation.** `/translate` never produces audio. The desktop app shows the translation as a draft and calls `/speak` only after the user confirms (and possibly edits) it, with exactly that text.

Every error has the same shape, with a stable `code` and a message that is safe to show users (no exception text or secrets):

```json
{ "error": { "code": "translation_unavailable", "message": "Translation is not configured on the server (missing GOOGLE_API_KEY)." } }
```

Codes: `invalid_request` (422), `translation_unavailable` / `speech_unavailable` (503), `upstream_error` (502), `upstream_timeout` (504), `not_found`, `method_not_allowed`, `internal_error`.

## Contract (OpenAPI)

The Pydantic models in `signflow_api/schemas.py` are the source of truth. The committed [`openapi.json`](openapi.json) is generated from them, and the desktop app generates its TypeScript types from it.

```bash
python -m scripts.export_openapi          # after changing schemas or routes
python -m scripts.export_openapi --check  # CI: fails if openapi.json is stale
```

## Tests and lint

```bash
python -m pytest        # API, config, providers (fake LLM + stubbed Polly), OpenAPI drift
ruff check . && ruff format --check .
```

No test needs real credentials or network access.

## Translation quality evaluation

`python -m evals` scores translations of 25 synthetic ASL gloss cases with deterministic checks for negation, numbers, time references and medical terms, and reports latency. It writes JSON and Markdown reports to `evals/out/`. It is offline by default. Real Gemini calls happen only with `--live`. See [`evals/README.md`](evals/README.md).

```bash
python -m evals            # offline: scores the cases' own reference answers (dataset/check sanity, not model quality)
python -m evals --live     # real Gemini calls with GOOGLE_API_KEY (uses quota)
```

## Layout

```
main.py                 entry point (uvicorn main:app)
signflow_api/
  config.py             settings + credential handling
  schemas.py            Pydantic wire contract
  app.py                FastAPI app factory, routes, CORS
  errors.py             error codes and handlers
  translation.py        Gemini translator
  speech.py             Polly synthesizer
scripts/export_openapi.py
openapi.json            generated contract (committed)
evals/                  translation quality evaluation (python -m evals)
tests/
```
