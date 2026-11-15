# Real ASL recognition: Umar's recognizer in SignFlow

SignFlow can take its signs from Umar's live ASL recognizer (`live.py`, branch `keyword-model-v5`) instead of the scripted demo recognizer. The recognizer runs as its own local process and owns the camera. SignFlow connects to it over a loopback WebSocket. Everything after recognition (drafting English with Gemini or the demo rules, the editable draft, confirmation, Kokoro or system speech) is unchanged.

> **Tested recognizer version:** branch `keyword-model-v5` at commit **`d911607`** (`d911607869bd3d5ac8051093b8c2f63bc384dd1f`, "Ignore large models and caches; add live test logs"). The setup below pins that commit.
>
> **Verification status:** recorded-data tests passed (the built app against a WebSocket stand-in replaying the recognizer's message format, and Umar's real engine fed recorded landmark rows from his branch). **Accuracy with a live human signer has not been verified yet.**

> `keyword-model-v5` has **unrelated Git history** (no common ancestor with `main`). Never merge or rebase it into `main`. Check it out separately (below). SignFlow's repo contains none of its code, models, landmarks or data.

## Run it

**Once, set up the recognizer** (Python 3.11, macOS; about 1 GB with PyTorch):

```bash
# from the signflow repo: a separate, read-only checkout of Umar's branch
git fetch origin keyword-model-v5
git worktree add --detach ../signflow-ml d911607869bd3d5ac8051093b8c2f63bc384dd1f
cd ../signflow-ml
python3.11 -m venv slenv
./slenv/bin/pip install -r requirements.txt
shasum -a 256 models/sign_model.joblib   # must match "sha256" in models/RELEASE.json
```

**Each demo (two terminals):**

```bash
# Terminal 1: the recognizer (camera + preview window with hand tracking, ws://localhost:8765)
cd ../signflow-ml && ./slenv/bin/python src/live.py

# Terminal 2: SignFlow
cd desktop && npm run dev
```

**With the camera preview inside SignFlow** (instead of terminal 1): `../signflow-ml/slenv/bin/python desktop/scripts/asl/signflow_recognizer.py --ml ../signflow-ml`, run from the signflow repo. It runs the same recognizer, unmodified, and also sends throttled preview frames over loopback. See [`realtime-modes.md`](realtime-modes.md).

In SignFlow, go to **Settings › Recognition › Sign recognizer › SignFlow ASL model (local)**, then **Live › Start recognition**. Keep the recognizer's window next to SignFlow: it is the camera preview, and it shows when a sign starts and ends.

- **Camera permission:** macOS asks once, for the app that runs `live.py` (Terminal, iTerm or VS Code), not for SignFlow. Allow it, then restart that app.
- **The recognizer can start before or after SignFlow.** SignFlow retries while recognition is on (0.5 s, doubling up to 3 s), and reconnects if the recognizer restarts.
- **How to sign** (from the recognizer's README): keep your upper body and both hands in view. Raise your hands above mid-chest, sign, then lower them; lowering ends the sign. Start the next sign within ~1.5 s, or the sentence ends there and SignFlow drafts what it has. Signs of the next sentence are appended to the same draft until you confirm or discard it.
- **No camera / rehearsal:** the recognizer replays clips with `--headless --video clip.mp4` (see its README). SignFlow's own tests use a WebSocket stand-in instead (`desktop/e2e/support/fakeAslRecognizer.ts`).

## Models

| | 14-sign demo model (default) | 116-sign keyword model (opt-in) |
| --- | --- | --- |
| Start | `python src/live.py` | `python src/live.py --keyword`, **and** turn on "Allow the 116-sign keyword model" in Settings › Recognition |
| Signs | BATHROOM, DOCTOR, DRINK, FOOD, HELP, HUNGRY, NO, PLEASE, READY, SORRY, STOP, THANK-YOU, THIRSTY, YES | 116 (`models/vocab_116.json` in the recognizer) |
| Sent | Signs with confidence ≥ 0.5 only, with the top-3 | Every segmented sign, with the top-5 and a `confident` flag (calibrated top-1 ≥ 0.35) |
| Held-out signers (model card) | top-1 94% (optimistic: picked on these folds) | top-1 ~75%, top-5 ~91% |
| Webcam (one tester, 17 clips) | 14/17 | 13/17 top-1, 17/17 top-5 |

Without the opt-in, SignFlow refuses keyword-model messages and says so on the Live screen. That keeps the demo predictable: the default path is the small, more reliable vocabulary.

## What SignFlow does with the messages

The recognizer sends one JSON message per event (README: "What the frontend receives"). The Electron **main process** is the only part of SignFlow that reads them (`desktop/src/main/recognizer/`). It validates and normalizes each one (`desktop/src/shared/recognizer.ts`) and forwards only typed events to the main window over IPC.

| Recognizer | SignFlow |
| --- | --- |
| `ts` (seconds) | `ts` in ms. A clock more than 60 s off "now" is replaced by the receive time. |
| `sign` / `top1` | `gloss`, normalized to SignFlow's convention and the backend's gloss pattern: `THANKYOU` → `THANK-YOU`. `NOTHING` and anything invalid are dropped. |
| `confidence` / calibrated top-1 probability | `confidence` (0..1). It's the model's estimate, not an accuracy guarantee. |
| keyword `confident: false` | `uncertain: true`: shown, **never used** for a draft, whatever its probability. |
| `candidates` | `alternatives`, display only ("or STOP 5% · DOCTOR 2%"). Never sent to translation. |
| (none) | `id` = `asl-<ts ms>-<gloss>`, so a duplicate delivery keeps its id and is dropped. |
| `end_of_sentence` | A sentence end: SignFlow drafts the accepted signs right away instead of after its fixed pause. If no sentence end ever arrives (e.g. the recognizer quit mid-sentence), it drafts 6 s after the last sign. |

As before, a sign is used only if it is final, not uncertain, and at or above **Minimum confidence** (Settings › Recognition, default 0.6). Unused signs stay visible: on the Live stage the newest one shows as "HELP? not used · 55%" or "model unsure", and the Workspace feed lists every sign with its alternatives.

Anything malformed is dropped and logged (rate-limited) by the main process. That covers messages that aren't JSON, have an unknown type, are over 8 KB, have confidence outside 0..1, glosses with spaces or punctuation, or more than 10 candidates.

## Camera ownership

The recognizer opens the camera with OpenCV and runs MediaPipe itself. If SignFlow also opened it, there would be two capture sessions and two camera permissions (the terminal and Electron). So with the ASL recognizer selected:

- SignFlow never calls `getUserMedia`. An open SignFlow camera is released when you switch to it.
- Live shows **Start / Stop recognition** and says where the preview is. The top bar shows "Recognition on/off", and Settings › Camera explains why there's no preview.
- The privacy note changes to: video stays in the recognizer on this device; SignFlow receives only recognized signs.

Switching back to **Demo (simulated)** restores the camera and the scripted demo recognizer, which remains the reliable fallback. If the recognizer can't be reached, the Live stage offers **Use the demo recognizer instead**.

## Security

- **Network:** SignFlow connects only to `ws://127.0.0.1:8765` (`SIGNFLOW_RECOGNIZER_PORT` overrides the port, for tests). It opens no listener, and the renderer's Content Security Policy is unchanged; the renderer never talks to the recognizer directly. The recognizer itself binds `localhost` (loopback), not a public interface.
- **IPC:** `recognizer:start/stop/status` are accepted only from the main window's own page, and events go only to the main window.
- **Trust:** any local process could pretend to be the recognizer on that port. Validation limits it to producing glosses, and nothing is spoken or sent anywhere without the user confirming the English first.
- **Model files:** the recognizer loads `joblib` (pickle) models, which can execute code. Only run models from the team branch, and check `sign_model.joblib` against `models/RELEASE.json`.

## License

The models and landmark files in the recognizer are derived from **WLASL**, which its authors release for **academic, non-commercial computational use only** (see the recognizer's `MODEL_CARD.md`). SignFlow doesn't redistribute the videos, landmarks or models: they stay in Umar's branch and on the machine that runs the recognizer. Don't ship them with a commercial build.

## Verified so far (2026-11-15, Apple M4)

- **Unit and E2E:** the parser, bridge, adapter, session and UI are covered. `desktop/e2e/asl.spec.ts` covers the built app against a WebSocket stand-in replaying the recognizer's exact message format.
- **Umar's real pipeline:** his `LiveEngine` (segmentation, model, send rules) and his WebSocket broadcaster were fed recorded MediaPipe landmark rows from his branch (`data/landmarks/wlasl/*`), at 30 fps, and connected to the built SignFlow app on port 8765.
  - **14-sign model:** HELP 0.94, DOCTOR 0.99, HUNGRY 0.71, FOOD 1.00.
  - **Keyword model:** HELP, DOCTOR, THANK-YOU, SORRY at ≥ 0.99. THANKYOU arrived normalized.
  - **In SignFlow:** each became a sign chip about 0.1 s after the recognizer sent it, and a draft 0.35 s after its sentence end (demo translator). SignFlow opened no camera stream.
  - **Caveat:** these clips are the model's *training* data, so this checks the pipeline, not accuracy.
- **Real camera, idle check:** the unmodified `live.py` captured the webcam (1920×1080, ~32 fps), SignFlow connected, and SignFlow opened no camera of its own. In 25 s with nobody signing, it sent nothing.
- **Not verified yet:** recognition accuracy with a live human signer through SignFlow. Rehearse with the actual demo signer, lighting and camera.

## Limitations

- **Isolated signs only:** no grammar, fingerspelling, facial expressions or continuous signing.
- **Small vocabulary (14 by default):** anything else comes out as the closest known sign, or nothing.
- **Unknown gestures aren't rejected:** on the keyword model they often come out *confident* (53% of out-of-vocabulary clips in the model card).
- **Look-alike signs get confused:** STOP/COOK, THANK YOU/GIVE.
- **Pace and framing:** the signer must keep a steady pace (≤ 1.5 s between signs), stay in frame, and have good light.
- **Live signers differ from the dictionary videos the models were trained on.** The model card lists the weak signs.
- **Not a replacement for an interpreter.** The confirmation step exists because recognition can be wrong.
