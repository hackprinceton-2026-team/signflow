import { join } from 'node:path';
import { BrowserWindow, type WebPreferences } from 'electron';
import { APP_ORIGIN } from './security';

const preloadPath = join(__dirname, '../preload/index.js');

/** The one set of webPreferences every SignFlow window uses. */
export function secureWebPreferences(): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    webviewTag: false,
  };
}

/**
 * E2E-only: remember the webPreferences each window was created with so the
 * Playwright smoke test can assert them (Electron 45 has no getter for this).
 */
export function recordPrefsForE2e(win: BrowserWindow, prefs: WebPreferences): void {
  if (process.env['SIGNFLOW_E2E'] !== '1') return;
  const g = globalThis as { __SIGNFLOW_WINDOW_PREFS__?: Record<number, WebPreferences> };
  g.__SIGNFLOW_WINDOW_PREFS__ ??= {};
  g.__SIGNFLOW_WINDOW_PREFS__[win.id] = { ...prefs };
}

/** URL for a renderer HTML entry, in dev (Vite server) or prod (app://). */
export function rendererUrl(entry: 'index' | 'captions'): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  // E2E runs tell the renderer to use silent speech (no audio during tests).
  const query = process.env['SIGNFLOW_E2E'] === '1' ? '?e2e=1' : '';
  if (devUrl) return `${devUrl}/${entry}.html${query}`;
  return `${APP_ORIGIN}/${entry}.html${query}`;
}

export function createMainWindow(): BrowserWindow {
  const webPreferences = secureWebPreferences();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'SignFlow',
    backgroundColor: '#0f1115',
    webPreferences,
  });
  recordPrefsForE2e(win, webPreferences);

  win.once('ready-to-show', () => win.show());
  void win.loadURL(rendererUrl('index'));
  return win;
}
