# SignFlow

> Real-time sign language → English, on your desktop. Built at **HackPrinceton 2026**.

SignFlow watches your webcam and recognizes signs as you make them. It turns them into an English draft that you confirm or edit, then speaks it aloud, shows it in a floating caption window, or saves it to notes.

## Repository layout

| Path        | Owner     | What lives here                                               |
| ----------- | --------- | ------------------------------------------------------------- |
| `desktop/`  | Raimbek   | Electron + React + TypeScript desktop app (UI, webcam, TTS)   |
| `backend/`  | Muhammad   | API / realtime gateway between the desktop app and the model (originally built by Muhammad) |
| `ml/`       | Umar      | Sign recognition model: data, training, inference             |
| `docs/`     | Everyone  | Architecture, interface contracts, demo script                |

Each area is owned by one person. Please open a PR instead of committing directly to someone else's folder.

## How it fits together

```
┌────────────── desktop/ ──────────────┐      ┌── backend/ ──┐      ┌──── ml/ ────┐
│ Webcam → frames ─────────────────────┼─────▶│  realtime    │─────▶│  sign       │
│                                      │      │  gateway     │      │  recognizer │
│ Live signs + confidence ◀────────────┼──────│              │◀─────│             │
│ English draft → confirm → TTS        │      │  gloss → EN  │      └─────────────┘
│ Notes · Floating captions            │      └──────────────┘
└──────────────────────────────────────┘
```

The desktop app talks to the ML model and the backend through **adapters**. Mock adapters ship with the app, so the UI runs end to end before the real services are ready. The proposed wire format is in [`docs/interfaces.md`](docs/interfaces.md).

## Quick start (desktop)

```bash
cd desktop
npm install
npm run dev        # launches Electron with mock adapters
```

See [`desktop/README.md`](desktop/README.md) for scripts and architecture.

## Branching

- `main` is protected by convention: changes land through PRs only, and nobody force-pushes.
- Feature branches: `feat/<area>-<thing>`, e.g. `feat/desktop-frontend`, `feat/backend-ws`, `feat/ml-baseline`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat(desktop): add captions window`.

## Team

- **Raimbek**: desktop app and UI.
- **Muhammad**: original author of the backend (FastAPI service, Gemini translation) and its Backend and AI Engineering.
- **Umar**: ML

## Additional Engineering Contributions — Raimbek

Beyond the desktop UI, Raimbek worked on integrating and improving SignFlow's full application stack:

- **Desktop application:** Built the Electron, React, and TypeScript interface, including Live Mode, Workspace, Notes, floating captions, camera controls, accessibility features, and the translation confirmation workflow.
- **Backend integration:** Connected Muhammad's original FastAPI and Gemini backend to the desktop application, improved error handling and reliability, and added real-stack integration tests.
- **AI evaluation:** Developed an offline-first evaluation system with 25 synthetic ASL gloss scenarios, translation fidelity checks, automated tests, and reproducible reports.
- **AI performance engineering:** Added latency measurements, token usage reporting, thinking-token instrumentation, and optional Gemini thinking-level configuration.
- **Neural text-to-speech:** Integrated Kokoro-82M for natural, fully local speech generation on Apple Silicon, including multiple voices, secure process isolation, fallback handling, natural speed control, and reliable stop/cancel behavior.
- **Real ASL integration (in review, PR #7):** Built the desktop bridge connecting Umar's recognition model to SignFlow through a local WebSocket, preserving the existing translation, confirmation, and speech workflow. Integration has been tested with recorded data; live-signing accuracy still requires validation.

These improvements were developed alongside the team's existing backend and ML work.
