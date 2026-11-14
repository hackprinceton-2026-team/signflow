# desktop/

**Owner: Raimbek.** The SignFlow desktop app: Electron 45 + React 19 + TypeScript, built with electron-vite.

## Features

- **Webcam preview**: mirrored preview, device picker, macOS camera permission flow, clear error states
- **Live recognized signs**: streaming glosses with confidence meters. Provisional guesses are refined into final signs, and low-confidence signs are shown but kept out of the sentence (adjustable threshold).
- **English draft with confirmation**: after a pause in signing, the phrase is translated into an editable draft. Confirm (⌘/Ctrl+Enter), preview the voice, or discard. Nothing is spoken or saved until you confirm.
- **Text to speech**: system voices with rate, pitch, and volume, plus speak-last, pause, resume, stop, and auto-speak on confirm. Settings persist.
- **Notes mode**: confirmed sentences are appended silently to timestamped notes. Supports multiple notes, copy, and Markdown export through a native Save dialog.
- **Floating captions**: an always-on-top, transparent caption bar that stays over other apps and full-screen calls. Text size, opacity, and line count are adjustable.

Everything runs today on **mock adapters**, so the UI is fully demoable without the backend or the model.

## Scripts

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Electron + Vite dev server with HMR                       |
| `npm run build`      | Production bundle into `out/`                             |
| `npm run typecheck`  | `tsc` for main/preload, renderer, and e2e projects        |
| `npm run lint`       | ESLint (includes guards against unsafe `webPreferences`)  |
| `npm test`           | Vitest unit + component tests                             |
| `npm run test:e2e`   | Builds, then runs Playwright smoke tests against Electron |
| `npm run check`      | typecheck + lint + unit tests                             |

## Layout

```
src/
  main/        Electron main process: windows, captions overlay, IPC handlers, security
  preload/     contextBridge: the typed `window.signflow` API, nothing else
  shared/      Cross-process contracts: IPC channels + validators, caption payloads, CSP
  renderer/
    index.html     main window
    captions.html  floating captions overlay
    src/
      adapters/    SignRecognizer / Translator / SpeechEngine interfaces + mocks
      state/       pure reducers (session, notes): most logic is unit-tested here
      hooks/       camera, frame sampler, session orchestration, speech, notes, captions
      components/  UI panels
      captions/    the overlay's React app
e2e/           Playwright tests that launch the real Electron app (fake camera)
```

## Plugging in the real backend / model

The UI depends only on the interfaces in `src/renderer/src/adapters/types.ts`:

| Interface        | Responsibility                                  | Mock today                  |
| ---------------- | ----------------------------------------------- | --------------------------- |
| `SignRecognizer` | frames in → `RecognizedSign` events out (ml/)    | `mock/mockRecognizer.ts`    |
| `Translator`     | signs → `EnglishDraft` (backend/)                | `mock/mockTranslator.ts`    |
| `SpeechEngine`   | text → audio                                    | `speech.ts` (system voices) |

To go live, implement a WebSocket-backed recognizer and translator that follow [`docs/interfaces.md`](../docs/interfaces.md), set `frameFormat: 'jpeg'` if the model wants frames (the sampler then sends ≤640px JPEGs at 10 fps), and add a `remote` case to `createAdapters()` in `adapters/index.ts`. No component changes are needed. The CSP already allows `ws://localhost:8000` and `http://localhost:8000` (`src/shared/csp.ts`).

## Security model

- Every window uses `contextIsolation`, `sandbox`, `webSecurity`, and has no `nodeIntegration`. The e2e suite asserts this.
- Production pages load from a custom privileged `app://signflow` scheme, never `file://`. Path traversal is rejected.
- A strict CSP is applied both as a `<meta>` tag and as a response header (`src/shared/csp.ts`). Production allows no inline or eval scripts.
- IPC handlers reject messages from any frame that isn't one of our top-level pages.
- Only the camera permission (video only) is granted. Navigation, `window.open`, and `<webview>` are blocked.
- IPC is authorized per window: only the main window can drive the captions overlay, and only the overlay can read its state or close itself. Every payload is validated and size-limited in main.
- Clipboard and file export go through main. The renderer has no clipboard permission and never chooses file paths; the user picks the file in a native dialog.
- E2E runs (`SIGNFLOW_E2E=1`) use a throwaway profile and silent speech, so tests never touch real data or play audio.
