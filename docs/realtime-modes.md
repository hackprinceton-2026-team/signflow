# Live modes: Words, Sentence (Gemini), Review

The Live screen has a **Mode** switch. The mode is remembered; Review is the default.

| Mode | What happens to recognized signs | AI | Confirmation |
| --- | --- | --- | --- |
| **Words** | Each accepted sign is spoken at once as a word (`THANK-YOU` → "thank you"). | None, no network | No |
| **Sentence (Gemini)** | Signs are collected until the sentence ends. Gemini composes an English sentence, which is spoken automatically. | **Gemini**, through the SignFlow backend | No, unless the sentence needs review (below) |
| **Review** | The original flow: an editable draft (Gemini in Live connection mode, demo rules in Demo). | As before | Yes, Confirm or Speak |

Words and Sentence say on screen that sign recognition isn't validated for medical or emergency use, and point to Review for anything important. **Stop speaking** stops the voice at once, empties the queue, and abandons a sentence still being composed.

## Words

- **Which signs are spoken:** a sign is spoken only if it is final, not marked uncertain by the model, and at or above Minimum confidence. Each sign id is spoken once. Rejected signs stay visible as "not used".
- **The queue:** speech goes through a bounded, ordered queue. Words that arrive while one is being spoken are spoken together next. Beyond 6 waiting words, the oldest are dropped and counted on screen.
- **What's shown:** the panel shows the text being spoken and the **measured** time from the end of the sign to the start of the audio.
- **No AI:** no Gemini request is made in Words mode. The tests assert zero `/translate` calls.

## Sentence (Gemini)

The **MLH Best Use of Gemini API** part. Gemini is the contextual sentence composer, not a word lookup. It turns signed glosses into a natural English sentence while keeping meaning, negation, quantities, medicine names and meaningful order.

1. **Collect:** accepted signs are collected until the recognizer's `end_of_sentence` (hands down 1.5 s), **Finish sentence**, or the usual pause with the demo recognizer.
2. **Compose:** the glosses go to the existing backend: `POST /translate { raw_signs, mode }`, then LangChain, then Gemini (`gemini-3.5-flash`, see `backend/`). The Everyday / Medical / Emergency context comes from Settings › Connection. Sentence mode uses the backend whether Connection says Demo or Live.
3. **Speak:** a faithful answer is spoken automatically (Kokoro, Heart by default when Kokoro is selected). The panel shows the source glosses, the sentence, a **Gemini** badge and Gemini's response time.

**Safety gate before auto-speaking:** a TypeScript port of the backend eval harness's deterministic checks (`backend/evals/checks.py`) runs on each answer. It flags:
- a dropped or added negation;
- a missing or invented number;
- a missing or invented medical term (allergy, penicillin, medicine, insulin, bleeding, emergency, …).

Any flag holds the sentence for **review**. The user then chooses: speak Gemini's version, speak the local one, or discard it.

**Fallback (labelled, no invented facts):** the local composition is the signed words in order, using the demo translator's deterministic rules.

| Situation | What happens |
| --- | --- |
| Gemini error (backend offline, no key, upstream error) | The local sentence is spoken **at once**, labelled "Local fallback" with the reason. |
| Gemini slower than 3 s | Shown as slow. **Speak now** (always available while composing) speaks the local sentence immediately. |
| Gemini slower than 12 s | The local sentence is spoken automatically. Normal Gemini replies take well under that (the backend's own budget is 3 s, its timeout 20 s). |
| Stale answers | A Gemini answer that arrives after a fallback, Speak now, Stop, a mode switch or a recognition restart is discarded: never spoken, never shown as the result. |

Sentences are composed one at a time, in order.

## Camera preview (embedded)

The ASL recognizer owns the camera, and SignFlow still never opens it. To see the camera inside SignFlow, start the recognizer with SignFlow's launcher instead of `live.py`:

```bash
# from the signflow repo; ../signflow-ml is Umar's checkout (docs/asl-recognizer.md)
../signflow-ml/slenv/bin/python desktop/scripts/asl/signflow_recognizer.py --ml ../signflow-ml
#   --keyword (116-sign model, opt-in) · --window (also his OpenCV window) · --preview-fps 15 · --preview-width 640 · --preview-quality 80 · --stats · --camera N
```

- **What the launcher reuses:** Umar's code **unchanged**, imported read-only from his checkout: `LiveEngine`, drawing, flags and message format.
- **What it adds:** 640-px JPEG preview frames at quality 80 (about 12–13 fps on an M4, about 35 KB each), keeping the camera's aspect ratio, with his hand-tracking overlay, on the same WebSocket, bound to `127.0.0.1` only. They are drawn, scaled and encoded on a separate thread that keeps only the newest frame, so the recognizer loop never waits for them; if encoding falls behind, the width steps down to 480 or 320 px. `--stats` logs loop FPS, inference time and preview cost every 5 s.
- **Camera hiccups:** it reopens the camera after a failed read instead of exiting.
- **In SignFlow:** Electron main validates each frame (JPEG marker, base64, dimensions, 200 KB cap) and forwards at most one per 80 ms. The stage shows it as a `data:` image, which the CSP already allows; the CSP is unchanged.
- **Fallback:** with plain `live.py` (no frames), Live shows the "preview is in the recognizer window" card as before.

### Which camera the recognizer uses

macOS can list an iPhone Continuity Camera alongside (or before) the built-in camera. The launcher therefore never assumes index 0:

- **Automatic (default):** prefers the built-in camera (AVFoundation device type `BuiltInWideAngleCamera` / built-in transport, or a MacBook/FaceTime/Built-in name), then other external cameras, then an iPhone.
- **The index is verified physically.** OpenCV only accepts an index, and its order is **not** AVFoundation's list order. On the test MacBook Air, AVFoundation listed the MacBook camera first, but OpenCV index 0 was the iPhone. The launcher finds a capture size only the wanted camera supports (the MacBook Air's 1552×1552), requests it from each index in turn, one camera open at a time, and uses the index that delivers it. The result is cached while the devices don't change.
  - **Side effect:** checking may briefly open the other camera (for example wake the iPhone) at startup.
  - **No unique size:** if the wanted camera has no capture size of its own, the launcher logs a warning and asks for `--camera N`.
- **Explicit choice always wins:** `--camera N` (an OpenCV index, used as is) or `--camera-name iPhone` (the first name containing it, index verified as above).
- **Listing cameras:** `--list-cameras` prints them.
- **Re-checked on every reopen:** if the chosen camera disappears, another is used and the log says which.
- **In SignFlow:** **Settings › Camera** shows the camera in use (automatic / chosen, verified or not) and the others available. Switching happens by restarting the launcher with a flag; there is no in-app switcher.
- **Setup:** listing cameras needs `pyobjc-framework-AVFoundation` in the recognizer's environment (`slenv/bin/pip install pyobjc-framework-AVFoundation`). Without it, cameras can't be identified, and index 0 is used with a warning to pass `--camera N`.

## Measured (Apple M4, 16 GB, 2026-11-15)

Measured in the built app with Kokoro (Heart). Audio was muted for the run, but synthesized and started.

| | Result |
| --- | --- |
| Words: sign end → audio start | **281–347 ms, median 305 ms** (10 words) |
| Sentence: sentence end → audio start, with an instantly answering fake Gemini | 299–363 ms (3 sentences): app + Kokoro overhead only |
| Preview frames shown in SignFlow (live camera) | **12.7 fps, 640×360**, ~35 KB base64 (before: 8.3 fps, 320×180, 9 KB) |
| Preview cost inside the recognizer loop | **0.00 ms/frame** (before: 4 ms per preview frame); recognizer loop 28–30 fps at 1920×1080, inference 18–26 ms/frame either way |
| CPU with the preview running | recognizer 103% (before 89%), Electron 33% (before 35%) |
| Kokoro synthesis while the recognizer and preview run (Test voice, median) | 588 ms (before 578 ms: no measurable change; the recognizer's CPU load slows Kokoro either way vs ~460 ms idle) |

**Not measured, and why:**
- **Real Gemini response time:** no live Gemini calls were authorized. Add it to the Sentence numbers; the backend eval harness can measure it with `--live`.
- **The recognizer's own delay:** its end-of-sign rule (~0.27 s after the hands drop) and prediction come before the times above. So "hands down → first audio" in Words mode is an **estimated** ~0.6 s.
