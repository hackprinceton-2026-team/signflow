import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [join(__dirname, '..'), '--use-fake-device-for-media-stream'],
    env: { ...process.env, SIGNFLOW_E2E: '1', ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('main window loads from the app:// origin', async () => {
  await expect(page).toHaveTitle('SignFlow');
  expect(page.url()).toBe('app://signflow/index.html');
  await expect(page.getByRole('heading', { name: 'SignFlow' })).toBeVisible();
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

test('app info comes through the IPC bridge', async () => {
  await expect(page.getByTestId('app-info')).toContainText('SignFlow v0.1.0');
  await expect(page.getByTestId('app-info')).toContainText('Electron');
});

// Keep last: Playwright keeps waiting on the cancelled navigation, so later
// locator calls on `page` would hang. The main process is the source of truth.
test('navigation to external sites is blocked', async () => {
  await page.evaluate(() => {
    window.location.href = 'https://example.com';
  });
  await page.waitForTimeout(500);
  const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL());
  expect(url).toBe('app://signflow/index.html');
});
