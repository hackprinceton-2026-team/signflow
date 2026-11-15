# Plugging a sign model into SignFlow (`SignRecognizer`)

For Umar (ML). This is the one interface the desktop app needs from a real model. Everything after recognition (drafting English with Gemini, the editable draft, confirmation, speech, captions, notes) already works and doesn't change.

Today both Demo and Live mode use `MockSignRecognizer` (`desktop/src/renderer/src/adapters/mock/mockRecognizer.ts`), which emits scripted glosses while camera frames are flowing.

## The interface

`desktop/src/renderer/src/adapters/types.ts`:

```ts
interface SignRecognizer {
  readonly name: string;                     // shown in Settings › Recognition
  readonly frameFormat: 'none' | 'jpeg';     // what pushFrame receives (below)
  readonly simulated?: boolean;              // true only for the scripted demo recognizer; leave unset
  start(): Promise<void>;                    // camera turned on
  stop(): void;                              // camera turned off
  pushFrame(frame: VideoFrameInput): void;   // ~10 fps while the camera is on
  onSign(cb: (sign: RecognizedSign) => void): Unsubscribe;
  onStatus(cb: (status: AdapterStatus) => void): Unsubscribe;
}

interface VideoFrameInput { ts: number; width: number; height: number; jpeg?: Blob }

interface RecognizedSign {
  id: string;          // stable per sign: re-emit with the same id to refine it
  gloss: string;       // e.g. "HELLO", "THANK-YOU", "IX-1", "#IF", fingerspelling "R-A-I"
  confidence: number;  // 0..1
  ts: number;          // ms since epoch, when the sign ended
  final: boolean;      // false = provisional (shown, not used); true = usable
}

interface AdapterStatus { state: 'idle' | 'connecting' | 'ready' | 'error'; message?: string }
```

## What the app does with it

| Step | Behavior |
| --- | --- |
| Lifecycle | `start()` when the user turns the camera on, `stop()` when it goes off. `start()` may be called again after `stop()`. Emit `connecting` → `ready` (or `error` with a user-readable `message`); the top bar shows it. |
| Frames | `useFrameSampler` calls `pushFrame` at 10 fps. With `frameFormat: 'none'` you get `{ ts, width, height }` only. With `'jpeg'` you also get a JPEG `Blob` (longest edge ≤ 640 px, quality 0.7). Frames are **dropped, never queued**, while one is encoding; do the same if your model is busy. With `'jpeg'`, the camera's privacy note says frames are sent to the sign recognition model. |
| Labels | The demo recognizer sets `simulated: true`, which shows a "Simulated signs" pill and a "· simulated" tag. A real model leaves it unset, so those labels disappear. |
| Signs | Every event appears in the live sign feed. Only events with `final: true` **and** `confidence >= minConfidence` (default 0.6, user-adjustable 0.3–0.95) go into the sentence. Re-emitting an `id` replaces it; a refinement below the threshold removes it again. |
| Drafts | After `pauseMs` (default 1.6 s, adjustable 0.6–3 s) with no new accepted sign, the buffered glosses are translated: Live mode `POST /translate { raw_signs, mode }` (Gemini), Demo mode the mock translator. The user edits, then confirms. |
| Speech | Never triggered by the recognizer. Only text the user confirms is spoken. |

## Gloss rules (enforced by the backend)

`POST /translate` rejects the whole request with 422 if any gloss breaks these, so normalize in the adapter:

- Pattern `^[A-Za-z0-9#][A-Za-z0-9#'+.\-]{0,39}$`: one token, no spaces, at most 40 characters. Use `-` to join words (`THANK-YOU`) and letters (`R-A-I`).
- At most 64 glosses per request (the desktop splits longer runs).
- Uppercase is conventional; the backend uppercases anyway.

## Where it can run

1. **Through the backend (recommended).** Serve recognition from the FastAPI app on `localhost:8000`, for example a WebSocket `ws://localhost:8000/ws/recognize` that takes JPEG frames (or landmarks) and streams `RecognizedSign` JSON. The renderer's Content Security Policy already allows `http://localhost:8000` and `ws://localhost:8000`, and nothing else. Add the message shapes to the backend's Pydantic schemas so they land in `openapi.json` and the desktop contract tests.
2. **In the renderer** (TF.js / MediaPipe in JavaScript). WebAssembly needs `'wasm-unsafe-eval'` in `script-src`, which the CSP doesn't allow today. That's a security-reviewed change (see `CLAUDE.md`).
3. **A separate local service** on another port needs a CSP change too. Prefer option 1.

## Wiring it in

1. Add `desktop/src/renderer/src/adapters/remote/remoteRecognizer.ts` implementing `SignRecognizer` (for option 1, a WebSocket client with `frameFormat: 'jpeg'`).
2. Return it from `createAdapters()` in `desktop/src/renderer/src/adapters/index.ts`. The recognizer is shared by Demo and Live mode, so switching modes never restarts it.
3. Test with `FakeRecognizer` (`desktop/src/renderer/src/test/fakes.ts`) as a model, and add unit tests for: provisional → final with the same `id`, status transitions, reconnect after `stop()`/`start()`, and dropping frames under load.

Minimal shape:

```ts
export class RemoteRecognizer implements SignRecognizer {
  readonly name = 'SignFlow model';
  readonly frameFormat = 'jpeg' as const;
  private ws: WebSocket | null = null;
  private readonly signs = new Emitter<RecognizedSign>();
  private readonly status = new Emitter<AdapterStatus>();

  async start() {
    this.status.emit({ state: 'connecting' });
    this.ws = new WebSocket('ws://localhost:8000/ws/recognize');
    this.ws.onopen = () => this.status.emit({ state: 'ready' });
    this.ws.onerror = () => this.status.emit({ state: 'error', message: "Can't reach the sign model." });
    this.ws.onmessage = (e) => { const s = parseSign(e.data); if (s) this.signs.emit(s); }; // validate!
  }
  stop() { this.ws?.close(); this.ws = null; this.status.emit({ state: 'idle' }); }
  pushFrame(f: VideoFrameInput) { if (f.jpeg && this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount === 0) this.ws.send(f.jpeg); }
  onSign(cb: (s: RecognizedSign) => void) { return this.signs.on(cb); }
  onStatus(cb: (s: AdapterStatus) => void) { return this.status.on(cb); }
}
```

## Still open

- Frames or landmarks? Landmarks (MediaPipe Holistic) are far less data per frame, but running MediaPipe in the renderer hits the WebAssembly CSP note above.
- The vocabulary the first model covers (the mock uses about 25 common ASL glosses).

`docs/interfaces.md` has the earlier WebSocket proposal. This page describes what the code does today.
