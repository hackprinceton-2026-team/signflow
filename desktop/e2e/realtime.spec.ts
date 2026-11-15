/**
 * Words and Sentence (Gemini) modes, end to end in the built app:
 * - signs come from a WebSocket stand-in for the ASL recognizer (with preview frames),
 * - Gemini is the contract-validating backend stand-in on localhost:8000, made slow
 *   or failing per test. No real Gemini, AWS or Polly call is made.
 * Speech is silent in E2E runs; what is spoken shows on screen and in the transcript.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditAccessibility } from './support/axe';
import { asl, FakeAslRecognizer } from './support/fakeAslRecognizer';
import { MockBackend } from './support/mockBackend';

const backend = new MockBackend();
const recognizer = new FakeAslRecognizer();
let app: ElectronApplication;
let page: Page;
let userData: string;
/** A minimal valid JPEG (1×1), as the launcher's preview frames are JPEGs. */
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await backend.start();
  await recognizer.start();
  userData = mkdtempSync(join(tmpdir(), 'signflow-realtime-'));
  app = await electron.launch({
    args: [join(__dirname, '..'), '--use-fake-device-for-media-stream'],
    env: { ...process.env, SIGNFLOW_E2E: '1', SIGNFLOW_USER_DATA: userData, SIGNFLOW_RECOGNIZER_PORT: String(recognizer.port), ELECTRON_RENDERER_URL: '' },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await go('Settings');
  await choose('Sign recognizer', 'SignFlow ASL model (local)');
  await go('Live');
  await page.getByRole('button', { name: 'Start recognition' }).click();
  await expect(page.getByTestId('recognizer-status')).toContainText('Recognizing', { timeout: 10_000 });
});

test.afterAll(async () => {
  await app?.close();
  await recognizer.stop();
  await backend.stop();
  rmSync(userData, { recursive: true, force: true });
});

async function go(label: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();
  await expect(page.getByRole('heading', { level: 2, name: label })).toBeVisible();
}
const choose = (group: string, option: string) => page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();
const translateCalls = () => backend.callsTo('/translate').length;

test('Words: each sign is spoken at once, with no Gemini request and no confirmation', async () => {
  await choose('Mode', 'Words');
  await expect(page.getByTestId('mode-safety')).toContainText("isn't validated for medical or emergency use");
  const before = translateCalls();
  recognizer.send(asl.sign('HELP', 0.91));
  await expect(page.getByTestId('words-text')).toHaveText('help');
  await expect(page.getByTestId('words-latency')).toContainText('sign → speech');
  recognizer.send(asl.sign('THANKYOU', 0.95));
  await expect(page.getByTestId('words-text')).toHaveText('thank you');
  recognizer.send(asl.sign('YES', 0.55)); // below threshold: shown as not used, never spoken
  await expect(page.getByTestId('sign-chip-rejected')).toContainText('not used');
  recognizer.send(asl.end(['HELP', 'THANKYOU']));
  await page.waitForTimeout(800);
  await expect(page.getByTestId('words-text')).toHaveText('thank you');
  await expect(page.getByTestId('draft-text')).toHaveCount(0);
  expect(translateCalls()).toBe(before);
  await auditAccessibility(page, 'Live › Words');
});

test('the recognizer’s camera preview is embedded; the app opens no camera', async () => {
  recognizer.send({ type: 'preview', jpeg: JPEG, width: 320, height: 180, ts: Date.now() / 1000 });
  await expect(page.getByTestId('recognizer-preview')).toHaveAttribute('src', /^data:image\/jpeg;base64,\/9j\//);
  expect(await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => v.srcObject !== null))).toBe(false);
});

test('Sentence: Gemini (backend) composes the signed sentence and it is spoken without Confirm', async () => {
  backend.translate = (glosses) => (glosses.join(' ') === 'I ALLERGIC PENICILLIN' ? 'I am allergic to penicillin.' : `[AI] ${glosses.join(' ')}`);
  await choose('Mode', 'Sentence (Gemini)');
  recognizer.send(asl.sign('I', 0.9));
  recognizer.send(asl.sign('ALLERGIC', 0.9));
  recognizer.send(asl.sign('PENICILLIN', 0.9));
  await expect(page.getByTestId('sentence-pending')).toHaveText('I ALLERGIC PENICILLIN');
  recognizer.send(asl.end(['I', 'ALLERGIC', 'PENICILLIN']));
  await expect(page.getByTestId('sentence-text')).toHaveText('I am allergic to penicillin.', { timeout: 10_000 });
  await expect(page.getByTestId('sentence-source')).toContainText('Gemini');
  expect(backend.callsTo('/translate').at(-1)!.body).toEqual({ raw_signs: ['I', 'ALLERGIC', 'PENICILLIN'], mode: 'chat' });
  await expect(page.getByTestId('draft-text')).toHaveCount(0);
  await auditAccessibility(page, 'Live › Sentence');
  await go('Workspace');
  await expect(page.getByText('I am allergic to penicillin.')).toBeVisible(); // in the transcript as spoken
  await go('Live');
});

test('Sentence: Gemini outage → the local sentence is spoken at once, labelled', async () => {
  backend.translateError = { status: 502, code: 'upstream_error', message: 'Gemini is unavailable.' };
  recognizer.send(asl.sign('HELP', 0.9));
  recognizer.send(asl.sign('DOCTOR', 0.9));
  recognizer.send(asl.end(['HELP', 'DOCTOR']));
  await expect(page.getByTestId('sentence-text')).toHaveText('Help doctor.', { timeout: 10_000 });
  await expect(page.getByTestId('sentence-source')).toContainText('Local fallback');
  await expect(page.getByTestId('sentence-reason')).toContainText('Gemini unavailable');
  backend.translateError = null;
});

test('Sentence: slow Gemini → Speak now uses the local sentence; the late answer never replaces it', async () => {
  backend.translateDelayMs = 2500;
  backend.translate = () => 'Could I please have some water?';
  recognizer.send(asl.sign('WATER', 0.9));
  recognizer.send(asl.end(['WATER']));
  await expect(page.getByTestId('sentence-status')).toContainText('Gemini is composing');
  await page.getByRole('button', { name: /Speak now/ }).click();
  await expect(page.getByTestId('sentence-text')).toHaveText('Water.');
  await page.waitForTimeout(3000); // Gemini answers meanwhile
  await expect(page.getByTestId('sentence-text')).toHaveText('Water.');
  await expect(page.getByTestId('sentence-source')).toContainText('Local (not AI)');
});

test('Sentence: Stop while Gemini is composing → nothing is spoken when it answers', async () => {
  recognizer.send(asl.sign('HELLO', 0.9));
  recognizer.send(asl.end(['HELLO']));
  await expect(page.getByTestId('sentence-status')).toContainText('Gemini is composing');
  await page.getByTestId('realtime-stop').click();
  await expect(page.getByTestId('sentence-latest')).toHaveAttribute('data-status', 'stopped');
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('sentence-latest')).toHaveAttribute('data-status', 'stopped');
  backend.translateDelayMs = 0;
});

test('Sentence: an invented detail is held for review instead of being spoken', async () => {
  backend.translate = () => 'My appointment is tomorrow at 3.';
  recognizer.send(asl.sign('TOMORROW', 0.9));
  recognizer.send(asl.end(['TOMORROW']));
  const review = page.getByTestId('sentence-review');
  await expect(review).toContainText('Number not signed: 3.', { timeout: 10_000 });
  await expect(page.getByTestId('sentence-latest')).toHaveAttribute('data-status', 'review');
  await review.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('sentence-latest')).toHaveAttribute('data-status', 'discarded');
});

test('Review mode (the original draft + confirm flow) still works', async () => {
  backend.translate = () => 'Thank you.';
  await choose('Mode', 'Review');
  recognizer.send(asl.sign('THANKYOU', 0.95));
  recognizer.send(asl.end(['THANKYOU']));
  await expect(page.getByTestId('draft-text')).toHaveValue(/Thank you|thank you/i, { timeout: 10_000 });
  await page.getByRole('button', { name: /^Confirm/ }).click();
  await expect(page.getByTestId('confirm-toast')).toContainText('Confirmed');
});
