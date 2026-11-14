# desktop/

**Owner: Raimbek.** The SignFlow desktop app: Electron 45 + React 19 + TypeScript, built with electron-vite.

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
  main/       Electron main process: windows, IPC handlers, security hardening
  preload/    contextBridge: the typed `window.signflow` API, nothing else
  shared/     Types and constants shared across processes (IPC contract, CSP)
  renderer/   React UI (index.html = main window)
e2e/          Playwright tests that launch the real Electron app
```

## Security model

- Every window uses `contextIsolation`, `sandbox`, `webSecurity`, and has no `nodeIntegration`. The e2e suite asserts this.
- Production pages load from a custom privileged `app://signflow` scheme, never `file://`. Path traversal is rejected.
- A strict CSP is applied both as a `<meta>` tag and as a response header (`src/shared/csp.ts`). Production allows no inline or eval scripts.
- IPC handlers reject messages from any frame that isn't one of our top-level pages.
- Only the camera permission (video only) is granted. Navigation, `window.open`, and `<webview>` are blocked.
