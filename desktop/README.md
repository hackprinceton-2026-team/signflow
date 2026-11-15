# desktop/

**Owner: Raimbek.** The SignFlow desktop app: Electron 45 + React 19 + TypeScript, built with electron-vite. It's a camera-first, dark, keyboard-friendly app that runs end to end on mock ML and backend adapters.

## Screens

| Screen        | What it's for                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live**      | The camera fills the window. Recognized signs stream over it with per-sign confidence, and the English draft appears in a compact overlay: **Confirm · Speak · Edit · Discard**. |
| **Workspace** | Detailed sign feed (refining, accepted, and low-confidence signs, with an adjustable threshold), camera preview, conversation history, and playback.                            |
| **Notes**     | Two-pane notes. Turn on **Capture from Live** to add every confirmed sentence to the open note. Timestamps, copy, Markdown export.                                             |
| **Settings**  | Camera, recognition (threshold, pause before translating), speech, floating captions, notes, keyboard shortcuts, and About (versions, contract status, privacy).            |

**Focus Mode** (⌘⇧F / Ctrl+Shift+F) is distraction-free: no chrome, the camera edge to edge, real window fullscreen. The controls fade when the pointer is idle. Esc exits.

**Floating captions** is an always-on-top, transparent caption bar that stays above other apps, including full-screen video calls.

The draft follows you: on Workspace and Notes it appears as a dock at the bottom, so you can confirm without going back to Live.

## Demo and live modes

Choose in **Settings › Connection**:

| Mode     | Translation                                            | Speech                                     | Needs                          |
| -------- | ------------------------------------------------------ | ------------------------------------------ | ------------------------------ |
| **Demo** | Mock translator, on the device                         | System voice or **Kokoro** (on-device neural) | Nothing (Kokoro: the model, installed once) |
| **Live** | SignFlow backend (`POST /translate`, Gemini), with an Everyday / Medical / Emergency context | System voice, **Kokoro**, or **cloud voice** (`POST /speak`, Amazon Polly Generative: Ruth by default, or Danielle / Matthew) with automatic fallback to the on-device voice | The backend running on `http://localhost:8000` (see `backend/README.md`) |

Signs come from the demo recognizer in both modes unless you choose **Settings › Recognition › Sign recognizer › SignFlow ASL model (local)**: Umar's live recognizer (`live.py`), a separate process that owns the camera. Electron main bridges its loopback WebSocket, and SignFlow then never opens the camera. Setup, the two models (14 signs by default, 116-sign keyword model opt-in), message handling and limitations: [`docs/asl-recognizer.md`](../docs/asl-recognizer.md). Switching Demo/Live never restarts recognition.

Live mode is built to fail gracefully:
- **Status:** the backend's state shows in the top bar and in Settings (online, not configured, offline), with setup hints and "Check again". It's polled every 15 s, re-checked when the network returns, and refreshed immediately after any failed request.
- **Translation errors:** the backend's explanation appears in the draft (for example a missing `GOOGLE_API_KEY`), with **Retry** and **Use demo mode**. The latter finishes the same phrase locally; the signs are kept.
- **Cloud voice errors:** the same confirmed text is spoken with the system voice instead, and a notice says so. The cloud request gives up after 10 s so the fallback isn't left waiting.

### Live modes: Words, Sentence (Gemini), Review

The Live screen's **Mode** switch:
- **Words** speaks each recognized sign at once, with no AI.
- **Sentence (Gemini)** has Gemini, through the backend, compose each signed sentence and speaks it automatically, with a labelled local fallback and a safety review gate.
- **Review** is the original draft + confirm flow, still the default.

With the ASL recognizer started through `desktop/scripts/asl/signflow_recognizer.py`, its camera preview appears inside SignFlow; SignFlow still never opens the camera. Details and measurements: [`docs/realtime-modes.md`](../docs/realtime-modes.md).

### Voices (Settings › Speech)

- **Speech engine:** *System voice* or *Kokoro — Local Neural Voice* (see below). This is the on-device voice; in live mode with the cloud voice selected, it is the fallback.
- **Cloud voice:** Ruth (recommended), Danielle, or Matthew, all Amazon Polly **Generative**. The backend retries with Neural only if a voice lacks Generative, and says so.
- **System / fallback voice:** "Automatic" picks the most natural installed English voice (Premium or Enhanced macOS voices first, never novelty voices). The app waits briefly for macOS to load its voice list before speaking.
- **Voice in use:** shows the voice and engine that actually spoke last (for example "Ruth · Amazon Polly Generative", or the macOS voice after a fallback), or, before anything is spoken, what will be used.
- **Test voice** speaks a fixed sample phrase through the same path as confirmed text. It never speaks your text and doesn't change "Speak last".
- Defaults are natural playback: rate 1.0×, pitch 1.0, volume 100%. Cloud playback keeps the voice's pitch when the rate changes.

The backend URL is fixed to `http://localhost:8000` because it's the only backend origin the renderer's CSP allows (`src/shared/csp.ts`).

### Kokoro — Local Neural Voice

[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) speaks confirmed text with a natural neural voice, entirely on this device: no backend, no AWS, no Gemini, and no network after the one-time install.

```bash
cd desktop
npm run kokoro:install          # ~326 MB, once; verifies SHA-256 of every file
npm run dev                     # Settings › Speech › Speech engine › Kokoro — Local Neural Voice
```

- **Model:** `onnx-community/Kokoro-82M-v1.0-ONNX`, pinned to commit `1939ad2`, full-precision `onnx/model.onnx` (the reference quality, and the fastest variant measured on Apple Silicon). Installed to `~/Library/Application Support/SignFlow/models/Kokoro-82M-v1.0-ONNX` (override with `SIGNFLOW_KOKORO_MODELS`), never into the repo. `npm run kokoro:install -- --verify` re-checks it offline.
- **Voices:** Heart (`af_heart`, recommended), Bella (`af_bella`), Michael (`am_michael`). The voice files ship in the `kokoro-js` npm package; the install script checks them against the upstream hashes.
- **Speed:** the Rate slider (0.5–2×) is Kokoro's native speed, so the voice keeps its natural pitch. Pitch doesn't apply.
- **States:** *Not installed* (with the install command), *Installed*, *Loading model…*, *Ready · loaded in N s*, or *Unavailable* (with the reason and **Check again**). Selecting Kokoro loads the model in the background (about 1–2 s), so the first sentence doesn't wait for it.
- **Memory:** the model takes ~0.5–0.9 GB while Kokoro is selected. Switching back to the system voice (or closing every window) stops the engine and frees it; choosing Kokoro again reloads it in ~1 s. Kokoro never starts unless selected.
- **Fallback:** if Kokoro is missing, still loading fails, crashes, times out, or the audio device can't play, the system voice speaks the same confirmed text (or the sentences not yet spoken) and a notice says so. After three crashes Kokoro stays off until restart.
- **How it runs:** `kokoro-js` + ONNX Runtime (native CPU, performance-core threads) in an Electron `utilityProcess` (`src/main/kokoro/`), so loading and synthesis never block the UI. The renderer reaches it only through `window.signflow.kokoro` (validated IPC) and plays the returned WAV through an `<audio>` element. No CSP or sandbox setting changed. The utility process blocks all http(s) requests (`networkGuard.ts`), and transformers.js is set to local files only.
- **Playback:** text is split into sentences; all are queued at once and each plays as soon as it's ready and the previous one ended. Kokoro's ~0.35 s of leading silence is trimmed. **Stop** cancels queued sentences in the engine, and late results are discarded, so nothing stale plays.
- `npm run kokoro:bench` measures load and synthesis on this machine (`-- --play` plays every clip). Measured on an M4 MacBook (16 GB), see `docs/kokoro-tts.md`.

### Real-stack check (real backend, real Gemini, macOS voices)

Opt-in, and it speaks out loud. It starts the real FastAPI app from `../backend/.venv` with AWS credentials forced off (so Amazon Polly can't be called) and drives the built app with the system voices:

```bash
npm run build
SIGNFLOW_E2E_REALSTACK=1 npx playwright test e2e/realstack.spec.ts
```

It needs a Gemini key in `backend/.env` (`GOOGLE_API_KEY`) or the environment, and port 8000 free. `SIGNFLOW_E2E_SPEECH=system` is what makes an E2E launch use real system voices instead of the silent test engine.

## Speech and confirmation safety

- Nothing is **spoken or saved** until you confirm it.
- **Confirm** commits the text to the conversation (and to notes when capture is on).
- **Speak** confirms first, then speaks exactly the confirmed text. There is no way to speak an unconfirmed draft.
- In live mode, `/translate` returns text only. `/speak` is called only from the confirm path, with the final (possibly edited) text. Tests assert both on the wire.
- **Speak when confirming** (Settings) is opt-in and off by default. **Test voice** speaks a fixed phrase, never your text.
- The same rules hold for Kokoro: it is called only from the confirm path and Test voice, and its engine can't reach the network.
- Floating captions show unconfirmed in-progress text only if **Show in-progress text** is on.

## Keyboard

| Action                     | macOS | Windows / Linux  |
| -------------------------- | ----- | ---------------- |
| Confirm draft              | ⌘↵    | Ctrl+Enter       |
| Confirm and speak          | ⌘⇧↵   | Ctrl+Shift+Enter |
| Edit draft                 | ⌘E    | Ctrl+E           |
| Discard draft              | ⌘⌫    | Ctrl+Backspace   |
| Live / Workspace / Notes   | ⌘1–3  | Ctrl+1–3         |
| Settings                   | ⌘,    | Ctrl+,           |
| Focus Mode / exit          | ⌘⇧F / Esc | Ctrl+Shift+F / Esc |
| Floating captions          | ⌘⇧C   | Ctrl+Shift+C     |

All shortcuts come from one table (`src/renderer/src/app/shortcuts.ts`), which also renders the list in Settings. While you type, Esc and ⌘⌫ keep their normal meaning.

## Design system

- **Tokens** (`src/renderer/src/styles/tokens.css`): type scale, 4px spacing grid, radii, neutral/accent/semantic colors (WCAG AA on dark surfaces), glass overlays for use on the camera, elevation, motion. Motion collapses to zero under `prefers-reduced-motion`.
- **Primitives** (`src/renderer/src/ui/`): Button and IconButton (icon-only buttons require a label), Switch (`role="switch"`), RangeField, SelectField (native `<select>`), StatusPill (text plus dot, never color alone), Kbd, Card, ConfidenceMeter (`role="meter"`), and an original inline SVG icon set.
- **Typography:** Inter Variable, bundled locally, so the CSP stays `font-src 'self'`.
- A stylesheet guard test checks size, brace balance, and that every `var(--token)` used is defined.

## Accessibility

- Every screen is audited with **axe-core (WCAG 2.1 A/AA)** inside the real Electron app (`e2e/a11y.spec.ts`), including Focus Mode and the captions window. Serious or critical violations fail the run.
- Full keyboard operation, visible focus rings, a skip link, labeled icon buttons, and live regions for new drafts, confirmations, and captions.

## Scripts

| Command                     | What it does                                                         |
| --------------------------- | -------------------------------------------------------------------- |
| `npm run dev`               | Electron + Vite dev server with HMR                                  |
| `npm run build`             | Production bundle into `out/`                                        |
| `npm run typecheck`         | `tsc` for main/preload, renderer, and e2e projects                   |
| `npm run lint`              | ESLint (includes guards against unsafe `webPreferences`)             |
| `npm test`                  | Vitest unit + component tests                                        |
| `npm run test:e2e`          | Builds, then runs Playwright against Electron: smoke, accessibility, and live mode (against a contract-validating stand-in backend; `SIGNFLOW_E2E_BACKEND=external` uses a backend you started) |
| `npm run check`             | typecheck + lint + unit tests + contract check                       |
| `npm run contract:sync`     | Pin `../backend/openapi.json` and regenerate the TypeScript types (see `contract/`) |
| `npm run kokoro:install`    | Download and verify the Kokoro model (`-- --verify` checks only, offline) |
| `npm run kokoro:bench`      | Measure Kokoro load/synthesis on this machine (`-- --play` to listen) |

## Layout

```
src/
  main/        Electron main process: windows, captions overlay, fullscreen, IPC, security
  preload/     contextBridge: the typed `window.signflow` API, nothing else
  shared/      Cross-process contracts: IPC channels + validators, caption payloads, CSP
  renderer/
    index.html     main window
    captions.html  floating captions overlay
    src/
      app/         shell (rail, top bar), controller + context, screens, shortcuts, Focus Mode
      screens/     Live, Workspace, Notes, Settings
      live/        camera stage, sign ticker, draft overlay, confirmation toast
      components/  panels used by the screens (signs feed, transcript, notes, speech)
      ui/          design-system primitives and icons
      styles/      tokens, base, components, app
      adapters/    SignRecognizer / Translator / SpeechEngine interfaces, mocks (demo), remote/ (live backend)
      state/       pure reducers (session, notes): most logic is unit-tested here
      hooks/       camera, frame sampler, session orchestration, speech, notes, captions
      contract/    generated wire types from the backend contract (placeholder for now)
      captions/    the overlay's React app
contract/      contract tooling: generator, validator, tests
e2e/           Playwright tests that launch the real Electron app (fake camera)
```

## Plugging in the real backend / model

The UI depends only on the interfaces in `src/renderer/src/adapters/types.ts`:

| Interface        | Responsibility                                | Mock today                  |
| ---------------- | --------------------------------------------- | --------------------------- |
| `SignRecognizer` | frames in → `RecognizedSign` events out (ml/) | `mock/mockRecognizer.ts`    |
| `Translator`     | signs → `EnglishDraft` (backend/)             | `mock/mockTranslator.ts`    |
| `SpeechEngine`   | text → audio                                  | `speech.ts` (system voices), `kokoroSpeech.ts` (Kokoro, local) |

Live mode implements them over HTTP in `src/renderer/src/adapters/remote/`: `createBackendClient` (typed by the generated contract, with timeouts and typed errors), `RemoteTranslator`, `CloudSpeechEngine`, and `FallbackSpeechEngine`. Wire types are generated from the backend's Pydantic models (see [`contract/README.md`](contract/README.md)). A real recognizer can plug in the same way once `ml/` serves one.

## Security model

- Every window uses `contextIsolation`, `sandbox`, `webSecurity`, and has no `nodeIntegration`. The e2e suite asserts this.
- Production pages load from a custom privileged `app://signflow` scheme, never `file://`. Path traversal is rejected.
- A strict CSP is applied as a response header and a `<meta>` tag (`src/shared/csp.ts`). Production allows no inline or eval scripts.
- IPC is authorized per sender. Every handler rejects frames that aren't our top-level pages. Only the main window can drive the captions overlay or toggle fullscreen; only the overlay can read its state or close itself. Payloads are validated and size-limited in main.
- Only the camera permission (video only) is granted. Navigation, `window.open`, and `<webview>` are blocked.
- Kokoro runs in a separate `utilityProcess` with http(s) blocked and only `HOME`, `TMPDIR`, `PATH`, and `LANG` from the environment (never API keys). Its IPC is accepted only from the main window (not the captions overlay) and validates text length (≤ 400 chars, below what Kokoro would silently truncate), voice, speed, request ids, and the number of pending requests.
- Clipboard and file export go through main. The renderer has no clipboard permission and never chooses file paths.
- E2E runs (`SIGNFLOW_E2E=1`) use a throwaway profile and silent speech, so tests never touch real data or play audio. (Kokoro still synthesizes for real in E2E, muted; `e2e/kokoro.spec.ts` skips its real-model test when the model isn't installed.)
