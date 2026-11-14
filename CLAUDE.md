# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## Project

SignFlow is a HackPrinceton 2026 project that turns sign language into English in real time. It is a monorepo with one owner per area:

- `desktop/` (Raimbek): Electron + React + TypeScript app
- `backend/` (Muhammad): realtime gateway / API
- `ml/` (Umar): sign recognition model
- `docs/` (shared): architecture and interface contracts

## Ground rules

- **Stay in your lane.** Only modify files in the area you were asked to work on. Never edit, reformat, or delete a teammate's files without explicit permission.
- **Never force-push.** Never rewrite published history. Never push directly to `main` after the initial scaffold; use PRs.
- **Never commit secrets.** API keys go in `.env` (gitignored). Commit `.env.example` with placeholder values only.
- **Stage files explicitly** (`git add desktop/...`). Never use `git add -A` or `git add .` from the repo root.
- **No large binaries.** Model weights and datasets stay out of git (see `.gitignore`).
- Commit messages follow Conventional Commits with an area scope: `feat(desktop): ...`, `fix(backend): ...`, `chore(ml): ...`.

## Interfaces

The contract between areas lives in `docs/interfaces.md`. If you change a message shape, update that doc in the same PR and tag the other owners.

## Desktop (`desktop/`)

```bash
cd desktop
npm install
npm run dev          # Electron + Vite dev server, mock adapters
npm run typecheck    # tsc for main/preload and renderer
npm run lint         # eslint
npm test             # vitest unit/component tests
npm run build        # production bundle into desktop/out
npm run test:e2e     # Playwright smoke test against the built app
```

Electron security rules (do not relax without a review):

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`
- The renderer only reaches the main process through the typed `window.signflow` bridge in `src/preload`
- Every IPC handler validates its sender and its payload
- Navigation and `window.open` are blocked; only camera (`media`) permission is granted
- A strict Content Security Policy is set in each HTML entry
