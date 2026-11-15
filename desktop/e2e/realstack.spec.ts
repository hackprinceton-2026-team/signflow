/**
 * Real-stack verification (opt-in): the real Electron app, the real FastAPI
 * backend (../backend, started here), real Gemini, and real macOS system voices.
 *
 *   SIGNFLOW_E2E_REALSTACK=1 npx playwright test e2e/realstack.spec.ts
 *
 * Needs `npm run build`, `backend/.venv`, and a Gemini key in backend/.env
 * (GOOGLE_API_KEY) or the environment (GOOGLE_API_KEY / GEMINI_API_KEY).
 * AWS credentials are forced off for the backend, so Amazon Polly can never be
 * called; speech is the macOS system voice. Signs come from the mock recognizer.
 * This speaks out loud.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enabled = process.env['SIGNFLOW_E2E_REALSTACK'] === '1';
const BACKEND_DIR = join(__dirname, '..', '..', 'backend');
const API = 'http://127.0.0.1:8000';
/** Never AWS: no credentials file, no config, no instance metadata. */
const NO_AWS = { AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' };

let api: ChildProcess | null = null;
let app: ElectronApplication;
let page: Page;
let userData: string;
const requests: string[] = [];
/** Every origin the renderer contacted (checked: nothing but the app and the local backend). */
const origins = new Set<string>();

interface Spoken {
  text: string;
  voice: string | null;
  lang: string;
}

async function health(): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`${API}/health`);
    return res.ok ? ((await res.json()) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

async function startApi(env: Record<string, string> = {}): Promise<void> {
  api = spawn(join(BACKEND_DIR, '.venv', 'bin', 'uvicorn'), ['main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...NO_AWS, ...env },
    stdio: 'ignore',
  });
  await expect.poll(health, { timeout: 20_000 }).not.toBeNull();
}

async function stopApi(): Promise<void> {
  if (!api) return;
  const proc = api;
  api = null;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await exited;
  await expect.poll(health, { timeout: 10_000 }).toBeNull();
}

const go = async (label: string) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();
  await expect(page.getByRole('heading', { level: 2, name: label })).toBeVisible();
};
const choose = (group: string, option: string) => page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();
const spoken = () => page.evaluate(() => (window as unknown as { __spoken: Spoken[] }).__spoken);

async function setMode(mode: 'Demo' | 'Live (SignFlow AI)'): Promise<void> {
  await go('Settings');
  await choose('Mode', mode);
  if (mode !== 'Demo') await choose('Voice', 'System voice');
  await go('Live');
  const start = page.getByRole('button', { name: 'Start camera' });
  if (await start.isVisible()) await start.click();
  await expect(page.getByTestId('recognizer-status')).toContainText('Recognizing', { timeout: 10_000 });
}

/** Speak and wait until macOS has finished saying it (the app returns to idle). */
async function speakAndFinish(): Promise<void> {
  await page.getByRole('button', { name: /^Speak/ }).click();
  await expect(page.getByTestId('confirm-toast')).toContainText('Spoken');
  await expect(page.getByTestId('status-speaking')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('status-speaking')).toHaveCount(0, { timeout: 30_000 });
}

// Not serial: each test sets up its own mode, so a Gemini failure doesn't skip the recovery tests.
test.skip(!enabled, 'set SIGNFLOW_E2E_REALSTACK=1 (speaks out loud; needs backend/.venv and a Gemini key)');

test.beforeAll(async () => {
  expect(existsSync(join(BACKEND_DIR, '.venv', 'bin', 'uvicorn')), 'create backend/.venv first').toBe(true);
  expect(await health(), 'port 8000 is already in use; stop the other backend').toBeNull();
  await startApi();
  userData = mkdtempSync(join(tmpdir(), 'signflow-realstack-'));
  app = await electron.launch({
    args: [join(__dirname, '..'), '--use-fake-device-for-media-stream'],
    env: { ...process.env, SIGNFLOW_E2E: '1', SIGNFLOW_E2E_SPEECH: 'system', SIGNFLOW_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.on('request', (r) => {
    const url = new URL(r.url());
    requests.push(`${r.method()} ${url.pathname}`);
    // URL.origin is "null" for custom schemes like app://, so build it from protocol + host.
    origins.add(url.protocol === 'data:' || url.protocol === 'blob:' ? url.protocol : `${url.protocol}//${url.host}`);
  });
  // Record what reaches macOS speech, then let it speak as usual.
  await page.evaluate(() => {
    const w = window as unknown as { __spoken: Spoken[] };
    w.__spoken = [];
    const synth = window.speechSynthesis;
    const original = synth.speak.bind(synth);
    synth.speak = (u: SpeechSynthesisUtterance) => {
      w.__spoken.push({ text: u.text, voice: u.voice?.name ?? null, lang: u.lang });
      original(u);
    };
  });
});

test.afterAll(async () => {
  await app?.close();
  await stopApi();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test('the real backend is up, Polly is unreachable, and macOS voices are available', async () => {
  const h = await health();
  expect(h).toMatchObject({ status: 'ok', speech: 'not_configured' });
  const voices = await page.evaluate(async () => {
    const list = () => window.speechSynthesis.getVoices();
    for (let i = 0; i < 20 && list().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    return list().map((v) => `${v.name} (${v.lang})`);
  });
  test.info().annotations.push({ type: 'macOS voices', description: `${voices.length} installed` });
  expect(voices.some((v) => / \(en[-_]/.test(v))).toBe(true);
});

test('Live: mock signs → real Gemini draft → edit → Confirm (silent) → Speak (macOS voice)', async () => {
  await setMode('Live (SignFlow AI)');
  await expect(page.getByTestId('status-backend')).toHaveText('AI online', { timeout: 10_000 });
  const draft = page.getByTestId('draft-text');
  const error = page.getByRole('alert');
  await expect(draft.or(error)).toBeVisible({ timeout: 30_000 });
  if (await error.isVisible()) throw new Error(`Gemini did not translate: ${await error.innerText()}`);

  const aiText = await draft.inputValue();
  expect(aiText.trim().length).toBeGreaterThan(0);
  expect(requests.filter((r) => r === 'POST /translate').length).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'Gemini draft', description: aiText });
  expect(await spoken()).toEqual([]); // a draft on screen is never spoken

  // Plain Confirm (auto-speak is off by default): committed, still silent.
  await page.getByTestId('draft-text').press('ControlOrMeta+Enter');
  await expect(page.getByTestId('confirm-toast')).toContainText('Confirmed');
  expect(await spoken()).toEqual([]);

  // Next draft: edit it, then Speak. macOS says exactly the edited text.
  await expect(draft).toBeVisible({ timeout: 30_000 });
  const edited = `${(await draft.inputValue()).trim()} Thank you.`;
  await draft.fill(edited);
  expect(await spoken()).toEqual([]);
  await speakAndFinish();
  const said = await spoken();
  expect(said).toHaveLength(1);
  expect(said[0]).toMatchObject({ text: edited });
  expect(said[0]!.voice).toBeTruthy();
  expect(said[0]!.lang).toMatch(/^en[-_]/);
  expect(requests.filter((r) => r.endsWith('/speak'))).toEqual([]); // system voice: no cloud speech request

  await go('Settings');
  await expect(page.getByTestId('voice-in-use-pill')).toHaveText(`${said[0]!.voice} · macOS voice`);
});

test('Demo ↔ Live switching keeps recognizing and never speaks unconfirmed text', async () => {
  const before = (await spoken()).length;
  await setMode('Demo');
  await expect(page.getByTestId('status-backend')).toHaveCount(0);
  await expect(page.getByTestId('draft-text')).toBeVisible({ timeout: 20_000 });
  await setMode('Live (SignFlow AI)');
  await expect(page.getByTestId('status-backend')).toHaveText(/AI (online|offline|not configured)|Translation/, { timeout: 10_000 });
  expect((await spoken()).length).toBe(before);
});

test('backend offline: clear error → "Use demo mode" → confirmed text is still spoken', async () => {
  await setMode('Live (SignFlow AI)');
  await stopApi();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText("Can't reach the SignFlow backend", { timeout: 30_000 });
  await expect(page.getByTestId('status-backend')).toHaveText('AI offline');
  await alert.getByRole('button', { name: 'Use demo mode' }).click();
  await expect(page.getByTestId('draft-text')).toBeVisible({ timeout: 15_000 });
  const text = (await page.getByTestId('draft-text').inputValue()).trim();
  const before = (await spoken()).length;
  await speakAndFinish();
  expect((await spoken()).slice(before).map((s) => s.text)).toEqual([text]);
});

test('Gemini rejects the key: actionable error, health reports it, demo recovery works', async () => {
  await stopApi();
  await startApi({ GOOGLE_API_KEY: 'AIzaSignFlowInvalidKeyForTests0000000000' });
  await setMode('Live (SignFlow AI)');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Gemini API key was rejected', { timeout: 30_000 });
  await expect.poll(async () => (await health())?.['translation']).toBe('not_configured');
  await alert.getByRole('button', { name: 'Use demo mode' }).click();
  await expect(page.getByTestId('draft-text')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await stopApi();
});

test('nothing contacted AWS (Polly) or any host other than the app and the local backend', () => {
  const allowed = new Set(['app://signflow', 'http://localhost:8000', 'http://127.0.0.1:8000', 'data:', 'blob:']);
  expect([...origins].filter((o) => !allowed.has(o))).toEqual([]);
  expect(requests.filter((r) => r.endsWith('/speak'))).toEqual([]);
});
