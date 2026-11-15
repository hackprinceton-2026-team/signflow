# Interface contract (draft v0)

> **Status: proposal.** This is the shape the desktop app's mock adapters follow today. Raimbek (backend, since 2026-11-14; originally Muhammad) and Umar (ML) own the final shapes. Edit this doc in a PR, and the desktop adapters will follow it.

## Transport

The desktop app opens one WebSocket to the backend:

```
ws://localhost:8000/ws/session
```

Messages are JSON text frames with a `type` field. Video frames go as binary frames (JPEG), or as JSON landmark frames if the ML side prefers to run MediaPipe on the client.

## Desktop → backend

```jsonc
// Start a session
{ "type": "session.start", "sessionId": "uuid", "language": "ASL", "fps": 10 }

// One video frame (alternative to a binary JPEG frame)
{ "type": "frame", "ts": 1731600000123, "width": 640, "height": 480, "jpegBase64": "..." }

// The user confirmed (and possibly edited) a draft
{ "type": "draft.confirm", "draftId": "uuid", "text": "Hello, nice to meet you." }

{ "type": "session.stop" }
```

## Backend → desktop

```jsonc
// A recognized sign (from ml/), streamed as soon as it's available
{
  "type": "sign",
  "id": "uuid",
  "gloss": "HELLO",          // uppercase ASL gloss
  "confidence": 0.93,        // 0..1
  "ts": 1731600000456,       // ms epoch, end of the sign
  "final": true              // false = still refining; may be replaced by a later message with the same id
}

// The English draft for the glosses gathered so far
{
  "type": "draft",
  "draftId": "uuid",
  "text": "Hello, nice to meet you.",
  "glossIds": ["uuid", "uuid"],
  "confidence": 0.88
}

{ "type": "error", "code": "MODEL_UNAVAILABLE", "message": "..." }
```

## Desktop adapter interfaces (TypeScript)

These live in `desktop/src/renderer/src/adapters/types.ts`. The real implementations will wrap the WebSocket above.

```ts
interface SignRecognizer {
  start(): Promise<void>;
  stop(): void;
  pushFrame(frame: VideoFrameInput): void;
  onSign(cb: (sign: RecognizedSign) => void): Unsubscribe;
  onStatus(cb: (status: AdapterStatus) => void): Unsubscribe;
}

interface Translator {
  translate(signs: RecognizedSign[]): Promise<EnglishDraft>;
}

interface SpeechEngine {
  speak(text: string, opts: SpeechOptions): void;
  pause(): void; resume(): void; cancel(): void;
  voices(): SpeechVoice[];
}
```

## Open questions

- Does recognition run on raw frames on the server, or on landmarks (MediaPipe Holistic) computed on the client?
- Which sign vocabulary does the MVP model cover? (The mock uses about 25 common ASL glosses.)
- Does translation from gloss to English happen in `ml/` or in `backend/` (for example an LLM call)?
