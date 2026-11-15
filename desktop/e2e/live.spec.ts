/**
 * Live mode end to end: the real Electron app talking HTTP to a SignFlow backend.
 *
 * By default a contract-validating stand-in runs on localhost:8000 (see
 * ./support/mockBackend.ts). With SIGNFLOW_E2E_BACKEND=external the test uses
 * whatever backend is already running there (e.g. the real FastAPI app), and
 * skips the checks that need the stand-in's request log or a restart.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditAccessibility } from './support/axe';
import { MockBackend } from './support/mockBackend';

const external = process.env['SIGNFLOW_E2E_BACKEND'] === 'external';
const backend = external ? null : new MockBackend();

let app: ElectronApplication;
let page: Page;
let userData: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await backend?.start();
  userData = mkdtempSync(join(tmpdir(), 'signflow-live-'));
  app = await electron.launch({
    args: [join(__dirname, '..'), '--use-fake-device-for-media-stream'],
    env: { ...process.env, SIGNFLOW_E2E: '1', SIGNFLOW_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  await backend?.stop();
  rmSync(userData, { recursive: true, force: true });
});

const go = async (label: string) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();
  await expect(page.getByRole('heading', { level: 2, name: label })).toBeVisible();
};
const choose = (group: string, option: string) => page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

test('switch to live mode: the backend is reached through CORS and shows as online', async () => {
  await go('Settings');
  await choose('Mode', 'Live (SignFlow AI)');
  await expect(page.getByTestId('status-backend')).toHaveText('AI online', { timeout: 10_000 });
  await expect(page.getByTestId('backend-status')).toContainText('Online');
  if (backend) {
    const health = backend.callsTo('/health');
    expect(health.length).toBeGreaterThan(0);
    expect(health[0]!.origin).toBe('app://signflow'); // real cross-origin request from the packaged origin
  }
  await choose('Translation context', 'Medical');
  await choose('Voice', 'Cloud voice');
  await auditAccessibility(page, 'Settings › Connection (live)');
});

test('AI draft from the backend; /speak only after confirming, with the edited text', async () => {
  await go('Live');
  await page.getByRole('button', { name: 'Start camera' }).click();
  const draft = page.getByTestId('draft-text');
  await expect(draft).toBeVisible({ timeout: 20_000 });
  if (backend) {
    await expect(draft).toHaveValue('[AI medical] hello nice meet you');
    expect(backend.callsTo('/translate')[0]!.body).toEqual({ raw_signs: ['HELLO', 'NICE', 'MEET', 'YOU'], mode: 'medical' });
    expect(backend.callsTo('/speak')).toHaveLength(0); // a draft is on screen, nothing spoken
  }

  await draft.fill('Hello, nice to meet you, doctor.');
  if (backend) expect(backend.callsTo('/speak')).toHaveLength(0);
  await page.getByRole('button', { name: /^Speak/ }).click();
  await expect(page.getByTestId('confirm-toast')).toContainText('Spoken');
  if (backend) {
    await expect.poll(() => backend.callsTo('/speak').length).toBe(1);
    expect(backend.callsTo('/speak')[0]!.body).toEqual({ text: 'Hello, nice to meet you, doctor.' });
  }
  // The cloud audio really played (muted in e2e): no fallback to the system voice.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('notice-toast')).toHaveCount(0);
});

test('every request and response matched the OpenAPI contract', async () => {
  test.skip(!backend, 'needs the stand-in backend');
  expect(backend!.violations).toEqual([]);
});

test('offline: clear error, then "Use demo mode" finishes the phrase locally', async () => {
  test.skip(!backend, 'needs a backend the test can stop');
  await backend!.stop();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText("Can't reach the SignFlow backend at localhost:8000", { timeout: 20_000 });
  await expect(page.getByTestId('status-backend')).toHaveText('AI offline'); // refreshed by the failure, not the 15 s poll
  await alert.getByRole('button', { name: 'Use demo mode' }).click();
  await expect(page.getByTestId('draft-text')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('status-backend')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await backend!.start(); // for afterAll symmetry
});
