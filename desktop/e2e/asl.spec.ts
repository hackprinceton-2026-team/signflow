/**
 * The local ASL recognizer, end to end in the real (built) Electron app,
 * against a WebSocket stand-in for Umar's live.py that replays its recorded
 * message format. No Python, no camera: the recognizer owns the camera in real
 * use, and this proves the app never opens it.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditAccessibility } from './support/axe';
import { asl, FakeAslRecognizer } from './support/fakeAslRecognizer';

let app: ElectronApplication;
let page: Page;
let userData: string;
const recognizer = new FakeAslRecognizer();
const mainOutput: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await recognizer.start(); // a free port; the app is told which below
  userData = mkdtempSync(join(tmpdir(), 'signflow-asl-'));
  app = await electron.launch({
    args: [join(__dirname, '..'), '--use-fake-device-for-media-stream'],
    env: {
      ...process.env,
      SIGNFLOW_E2E: '1',
      SIGNFLOW_USER_DATA: userData,
      SIGNFLOW_RECOGNIZER_PORT: String(recognizer.port),
      ELECTRON_RENDERER_URL: '',
    },
  });
  app.process().stdout?.on('data', (d: Buffer) => mainOutput.push(String(d)));
  app.process().stderr?.on('data', (d: Buffer) => mainOutput.push(String(d)));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  await recognizer.stop();
  rmSync(userData, { recursive: true, force: true });
});

const go = async (label: string) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();
  await expect(page.getByRole('heading', { level: 2, name: label })).toBeVisible();
};
const choose = (group: string, option: string) => page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

test('choose the ASL recognizer: the app never opens the camera', async () => {
  await go('Settings');
  await choose('Sign recognizer', 'SignFlow ASL model (local)');
  await expect(page.getByTestId('camera-external-note')).toBeVisible();
  await go('Live');
  await expect(page.getByRole('button', { name: 'Start camera' })).toHaveCount(0);
  await auditAccessibility(page, 'Live (ASL recognizer, off)');
  await page.getByRole('button', { name: 'Start recognition' }).click();
  await expect(page.getByTestId('recognizer-status')).toContainText('Recognizing', { timeout: 10_000 });
  await expect.poll(() => recognizer.clientCount).toBe(1);
  await expect(page.getByTestId('status-camera')).toHaveText('Recognition on');
  // No capture session in the app: no <video> has a stream.
  expect(await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => v.srcObject !== null))).toBe(false);
  await auditAccessibility(page, 'Live (ASL recognizer, on)');
});

test('recorded signs → draft at the end of the sentence → confirm and speak; malformed messages are ignored', async () => {
  recognizer.send(asl.sign('HELP', 0.91, [['HELP', 0.91], ['STOP', 0.05], ['DOCTOR', 0.02]]));
  recognizer.send('{"type": "sign", "sign": "HELP; DROP TABLE", "confidence": 0.99}');
  recognizer.send('not json at all');
  recognizer.send({ type: 'sign', sign: 'NOTHING', confidence: 0.9, ts: Date.now() / 1000 });
  recognizer.send(asl.sign('DOCTOR', 0.84));
  await expect(page.getByTestId('sign-chip')).toHaveText(['HELP', 'DOCTOR']);
  await expect(page.getByTestId('draft-text')).toHaveCount(0);

  recognizer.send(asl.end(['HELP', 'DOCTOR']));
  const draft = page.getByTestId('draft-text');
  await expect(draft).toHaveValue('Help doctor.', { timeout: 5_000 });
  await draft.fill('I need a doctor.');
  await page.getByRole('button', { name: /^Speak/ }).click();
  await expect(page.getByTestId('confirm-toast')).toContainText('Spoken');
  await go('Workspace');
  await expect(page.getByText('I need a doctor.')).toBeVisible();
  await go('Live');
  expect(mainOutput.join('')).toContain('dropped message');
});

test('a low-confidence sign is shown as "not used" and drafts nothing', async () => {
  recognizer.send(asl.sign('YES', 0.55, [['YES', 0.55], ['DRINK', 0.3]]));
  await expect(page.getByTestId('sign-chip-rejected')).toContainText('not used · 55%');
  recognizer.send(asl.end(['YES']));
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('draft-text')).toHaveCount(0);
});

test('the keyword model is allowed by default; turned off, its messages are refused', async () => {
  // Turn it off (this restarts recognition with only the 14-sign model allowed).
  await go('Settings');
  const keywordSwitch = page.getByRole('switch', { name: /Allow the 116-sign keyword model/ });
  await expect(keywordSwitch).toHaveAttribute('aria-checked', 'true');
  await keywordSwitch.click();
  await expect(keywordSwitch).toHaveAttribute('aria-checked', 'false');
  await go('Live');
  await page.getByRole('button', { name: 'Start recognition' }).click();
  await expect(page.getByTestId('recognizer-status')).toContainText('Recognizing', { timeout: 10_000 });
  await expect.poll(() => recognizer.clientCount, { timeout: 10_000 }).toBe(1);

  recognizer.send(asl.keyword([['HEADACHE', 0.62], ['HOT', 0.14]], true));
  await expect(page.getByTestId('recognizer-status')).toContainText('Recognizer error');
  await expect(page.getByTestId('external-stage-message')).toContainText('116-sign keyword model');
  await expect(page.getByTestId('sign-chip')).toHaveCount(0);
});

test('the recognizer restarts: the app waits, reconnects, and keeps going', async () => {
  // Turn the keyword model back on (this restarts recognition with it allowed).
  await go('Settings');
  await page.getByRole('switch', { name: /Allow the 116-sign keyword model/ }).click();
  await go('Live');
  await page.getByRole('button', { name: 'Start recognition' }).click();
  await expect(page.getByTestId('recognizer-status')).toContainText('Recognizing', { timeout: 10_000 });

  await recognizer.stop();
  await expect(page.getByTestId('external-stage-message')).toContainText('python src/live.py', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Use the demo recognizer instead' })).toBeVisible();
  await recognizer.start();
  await expect(page.getByTestId('recognizer-status')).toContainText('Recognizing', { timeout: 10_000 });
  await expect.poll(() => recognizer.clientCount, { timeout: 10_000 }).toBe(1);

  recognizer.send(asl.keyword([['MOTHER', 0.99], ['FATHER', 0.01]], true));
  recognizer.send(asl.keyword([['SICK', 0.2], ['HELP', 0.19], ['HOW', 0.08]], false));
  await expect(page.getByTestId('sign-chip')).toHaveText(['MOTHER']);
  await expect(page.getByTestId('sign-chip-rejected')).toContainText('model unsure');
});

test('Stop recognition disconnects from the recognizer', async () => {
  await page.getByRole('button', { name: 'Stop recognition' }).click();
  await expect.poll(() => recognizer.clientCount, { timeout: 5_000 }).toBe(0);
  const before = recognizer.connections;
  await page.waitForTimeout(2000);
  expect(recognizer.connections).toBe(before); // no reconnecting after Stop
  await expect(page.getByTestId('status-camera')).toHaveText('Recognition off');
});

test('back to the demo recognizer: the camera works as before', async () => {
  await go('Settings');
  await choose('Sign recognizer', 'Demo (simulated)');
  await go('Live');
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('status-camera')).toHaveText('Camera on');
  await expect(page.getByTestId('simulated-signs')).toBeVisible();
  await page.getByRole('button', { name: 'Stop camera' }).first().click();
});
