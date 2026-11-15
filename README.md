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

- **Raimbek**: desktop app; backend and AI engineering since November 14, 2026
- **Muhammad**: original author of the backend (FastAPI service, Gemini translation) and its Backend and AI Engineering owner until November 14, 2026
- **Umar**: ML
