import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let page: Page;
let userData: string;

/** Click a destination in the main navigation rail. */
async function go(label: 'Live' | 'Workspace' | 'Notes' | 'Settings') {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();
  await expect(page.getByRole('heading', { level: 2, name: label })).toBeVisible();
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'signflow-e2e-'));
  app = await electron.launch({
    args: [join(__dirname, '..'), '--use-fake-device-for-media-stream'],
    env: { ...process.env, SIGNFLOW_E2E: '1', SIGNFLOW_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userData, { recursive: true, force: true });
});

test('uses an isolated profile for e2e runs', async () => {
  const path = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  expect(path).toBe(userData);
});

test('main window loads from the app:// origin', async () => {
  await expect(page).toHaveTitle('SignFlow');
  expect(page.url()).toBe('app://signflow/index.html?e2e=1');
  await expect(page.getByRole('heading', { level: 1, name: 'SignFlow' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Live' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Camera is off' })).toBeVisible();
});

test('renderer has no Node.js access, only the typed bridge', async () => {
  const globals = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridge: typeof window.signflow,
    bridgeKeys: Object.keys(window.signflow).sort(),
  }));
  expect(globals.require).toBe('undefined');
  expect(globals.process).toBe('undefined');
  expect(globals.bridge).toBe('object');
  expect(globals.bridgeKeys).not.toContain('ipcRenderer');
});

test('every window uses secure webPreferences', async () => {
  const prefs = await app.evaluate(() => {
    const g = globalThis as { __SIGNFLOW_WINDOW_PREFS__?: Record<number, Record<string, unknown>> };
    return Object.values(g.__SIGNFLOW_WINDOW_PREFS__ ?? {}).map((p) => ({
      contextIsolation: p['contextIsolation'],
      nodeIntegration: p['nodeIntegration'],
      sandbox: p['sandbox'],
      webSecurity: p['webSecurity'],
    }));
  });
  expect(prefs.length).toBeGreaterThan(0);
  for (const p of prefs) {
    expect(p).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
  }
});

test('CSP is enforced: inline scripts are blocked', async () => {
  const ran = await page.evaluate(() => {
    const w = window as unknown as { __inlineRan?: boolean };
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true';
    document.body.appendChild(s);
    return Boolean(w.__inlineRan);
  });
  expect(ran).toBe(false);
});

test('app info comes through the IPC bridge (Settings › About)', async () => {
  await go('Settings');
  await expect(page.getByTestId('app-info')).toContainText('SignFlow v0.1.0');
  await expect(page.getByTestId('app-info')).toContainText('Electron');
  await go('Live');
});

test('Live: camera → signs over the camera → draft → edit + Confirm, then Speak', async () => {
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('recognizer-status')).toContainText('Recognizing', { timeout: 5000 });
  await expect(page.getByTestId('status-camera')).toHaveText('Camera on');

  // The fake camera produces real frames; the mock model only emits while frames flow.
  const videoReady = await page.getByTestId('webcam-video').evaluate((v: HTMLVideoElement) => v.videoWidth > 0);
  expect(videoReady).toBe(true);

  await expect(page.getByTestId('sign-chip').first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('meter').first()).toHaveAttribute('aria-valuenow', /\d+/);
  await expect(page.getByTestId('draft-text')).toHaveValue('Hello, nice to meet you.', { timeout: 15_000 });

  // Confirm (edited) commits without speaking.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByTestId('draft-text')).toBeFocused();
  await page.getByTestId('draft-text').fill('Hello, nice to meet you all.');
  await page.getByTestId('draft-text').press('ControlOrMeta+Enter');
  await expect(page.getByTestId('confirm-toast')).toContainText('Confirmed');
  await expect(page.getByTestId('status-speaking')).toHaveCount(0);

  // Speak confirms and reads aloud (silent engine in e2e runs).
  await expect(page.getByTestId('draft-text')).toHaveValue('How are you?', { timeout: 15_000 });
  await page.getByRole('button', { name: /^Speak/ }).click();
  await expect(page.getByTestId('status-speaking')).toBeVisible();
  await expect(page.getByTestId('confirm-toast')).toContainText('Spoken');

  // Workspace shows the details; recognition keeps running there.
  await go('Workspace');
  await expect(page.getByTestId('sign-row').first()).toBeVisible();
  await expect(page.getByTestId('utterance').nth(0)).toContainText('Hello, nice to meet you all.');
  await expect(page.getByTestId('utterance').nth(1)).toContainText('How are you?');

  await go('Live');
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await expect(page.getByText('Camera is off')).toBeVisible();
});

test('notes: capture confirmed sentences from the dock and export Markdown', async () => {
  await go('Notes');
  await page.getByLabel('Note title').fill('E2E lecture');
  await page.getByRole('switch', { name: 'Capture from Live' }).click();
  await expect(page.getByText('Capturing to notes')).toBeVisible();

  await go('Live');
  await page.getByRole('button', { name: 'Start camera' }).click();
  await go('Notes');
  // The draft follows onto other screens as a dock.
  await expect(page.getByTestId('draft-text')).toBeVisible({ timeout: 15_000 });
  const sentence = await page.getByTestId('draft-text').inputValue();
  await page.getByRole('button', { name: /^Confirm/ }).click();
  await expect(page.getByTestId('note-body')).toHaveValue(new RegExp(sentence.replace(/[.?]/g, '\\$&')));

  // Stub the native Save dialog in the main process, then export for real.
  const outFile = join(userData, 'export.md');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, outFile);
  await page.getByRole('button', { name: 'Export .md' }).click();
  await expect(page.getByText('Saved export.md')).toBeVisible();
  const md = readFileSync(outFile, 'utf8');
  expect(md.startsWith('# E2E lecture')).toBe(true);
  expect(md).toContain(sentence);

  await page.getByRole('switch', { name: 'Capture from Live' }).click();
  await go('Live');
  await page.getByRole('button', { name: 'Stop camera' }).click();
});

test('IPC rejects malformed export payloads', async () => {
  const err = await page.evaluate(async () => {
    try {
      // @ts-expect-error deliberately wrong payload
      await window.signflow.notes.exportMarkdown({ suggestedName: 'x', content: 123 });
      return 'no error';
    } catch (e) {
      return String(e);
    }
  });
  expect(err).toContain('Export content must be a string');
});

test('floating captions: secure always-on-top overlay that mirrors confirmed sentences', async () => {
  const opened = app.waitForEvent('window');
  await page.getByTestId('captions-toggle').click();
  const captions = await opened;
  await captions.waitForLoadState('domcontentloaded');
  expect(captions.url()).toBe('app://signflow/captions.html?e2e=1');
  await expect(page.getByTestId('captions-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(captions.getByTestId('captions')).toBeVisible();

  const overlay = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'SignFlow Captions');
    return w ? { onTop: w.isAlwaysOnTop(), focusable: w.isFocusable(), count: BrowserWindow.getAllWindows().length } : null;
  });
  expect(overlay).toMatchObject({ onTop: true, count: 2 });

  // Both windows were created with the hardened preferences.
  const prefs = await app.evaluate(() => {
    const g = globalThis as { __SIGNFLOW_WINDOW_PREFS__?: Record<number, Record<string, unknown>> };
    return Object.values(g.__SIGNFLOW_WINDOW_PREFS__ ?? {}).map((p) => [p['contextIsolation'], p['nodeIntegration'], p['sandbox']]);
  });
  expect(prefs.length).toBeGreaterThanOrEqual(2);
  for (const p of prefs) expect(p).toEqual([true, false, true]);

  // Sign → confirm in the main window → appears in the overlay.
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('draft-text')).toBeVisible({ timeout: 15_000 });
  await expect(captions.getByTestId('caption-live')).not.toBeEmpty();
  const sentence = await page.getByTestId('draft-text').inputValue();
  await page.getByTestId('draft-text').press('ControlOrMeta+Enter');
  await expect(captions.getByTestId('caption-line').last()).toHaveText(sentence);
  await page.getByRole('button', { name: 'Stop camera' }).click();

  // Per-window sender checks: the overlay can't toggle itself via the main-window API.
  const err = await captions.evaluate(async () => {
    try {
      await window.signflow.captions.setVisible(false);
      return 'allowed';
    } catch (e) {
      return String(e);
    }
  });
  expect(err).toContain('untrusted sender');

  // Closing from the overlay's own × updates the main window.
  await captions.getByRole('button', { name: 'Close captions' }).click();
  await expect(page.getByTestId('captions-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

// Keep last: Playwright keeps waiting on the cancelled navigation, so later
// locator calls on `page` would hang. The main process is the source of truth.
test('navigation to external sites is blocked', async () => {
  await page.evaluate(() => {
    window.location.href = 'https://example.com';
  });
  await page.waitForTimeout(500);
  const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL());
  expect(url).toBe('app://signflow/index.html?e2e=1');
});
