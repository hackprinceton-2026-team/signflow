/**
 * Kokoro local neural voice, end to end in the real (built) Electron app.
 *
 * 1. Model missing (an empty models folder): the app says so, explains how to
 *    install, and the Test voice falls back to the system voice.
 * 2. Model installed (the real ~326 MB model, if `npm run kokoro:install` has
 *    run): the utility process loads it, Test voice and a confirmed sentence are
 *    synthesized for real and "played" muted (E2E runs are silent), and the
 *    renderer makes no network request at all. Skipped when the model is absent.
 *
 * Timings from (2) are printed for the performance report.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { KOKORO_MODEL_DIRNAME, KOKORO_MODEL_FILES } from '../src/shared/kokoro';
import { auditAccessibility } from './support/axe';

const installedRoot = process.env['SIGNFLOW_KOKORO_MODELS'] || join(homedir(), 'Library', 'Application Support', 'SignFlow', 'models');
const modelInstalled = KOKORO_MODEL_FILES.every((f) => {
  try {
    return statSync(join(installedRoot, KOKORO_MODEL_DIRNAME, f.path)).size === f.size;
  } catch {
    return false;
  }
});

async function launch(
  modelsRoot: string,
): Promise<{ app: ElectronApplication; page: Page; userData: string; logs: string[]; requests: string[]; mainOutput: string[] }> {
  const userData = mkdtempSync(join(tmpdir(), 'signflow-kokoro-'));
  const app = await electron.launch({
    args: [join(__dirname, '..'), '--use-fake-device-for-media-stream'],
    env: { ...process.env, SIGNFLOW_E2E: '1', SIGNFLOW_USER_DATA: userData, SIGNFLOW_KOKORO_MODELS: modelsRoot, ELECTRON_RENDERER_URL: '' },
  });
  const mainOutput: string[] = [];
  app.process().stdout?.on('data', (d: Buffer) => mainOutput.push(String(d)));
  app.process().stderr?.on('data', (d: Buffer) => mainOutput.push(String(d)));
  const page = await app.firstWindow();
  const logs: string[] = [];
  const requests: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('request', (r) => {
    if (!r.url().startsWith('app://') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) requests.push(r.url());
  });
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData, logs, requests, mainOutput };
}

const go = async (page: Page, label: string) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();
  await expect(page.getByRole('heading', { level: 2, name: label })).toBeVisible();
};
const choose = (page: Page, group: string, option: string) =>
  page.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();

test.describe('Kokoro: model missing', () => {
  let ctx: Awaited<ReturnType<typeof launch>>;
  let emptyModels: string;

  test.beforeAll(async () => {
    emptyModels = mkdtempSync(join(tmpdir(), 'signflow-no-model-'));
    ctx = await launch(emptyModels);
  });
  test.afterAll(async () => {
    await ctx?.app.close();
    rmSync(ctx.userData, { recursive: true, force: true });
    rmSync(emptyModels, { recursive: true, force: true });
  });

  test('explains how to install, falls back to the system voice, and remembers the choice', async () => {
    const { page } = ctx;
    await go(page, 'Settings');
    await choose(page, 'Speech engine', 'Kokoro — Local Neural Voice');
    await expect(page.getByTestId('kokoro-status')).toHaveText('Not installed');
    await expect(page.getByTestId('kokoro-hint')).toContainText('npm run kokoro:install');
    await expect(page.getByTestId('voice-in-use')).toContainText("Kokoro isn't installed yet");
    await auditAccessibility(page, 'Settings › Speech (Kokoro missing)');

    await page.getByRole('button', { name: 'Test voice' }).click();
    await expect(page.getByTestId('notice-toast')).toContainText("Kokoro voice isn't installed. Used the system voice instead.");

    await page.reload();
    await go(page, 'Settings');
    await expect(page.getByRole('radiogroup', { name: 'Speech engine' }).getByRole('radio', { name: 'Kokoro — Local Neural Voice' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(ctx.requests).toEqual([]);
  });

  test('the main process validates Kokoro IPC payloads', async () => {
    const errors = await ctx.page.evaluate(async () => {
      const attempts: unknown[] = [
        { id: 'a', text: 'Hi.', voice: 'not-a-voice', speed: 1 },
        { id: 'a', text: '', voice: 'af_heart', speed: 1 },
        { id: 'a', text: 'x'.repeat(5000), voice: 'af_heart', speed: 1 },
        { id: '../../etc/passwd', text: 'Hi.', voice: 'af_heart', speed: 1 },
        'Hi.',
      ];
      const out: string[] = [];
      for (const a of attempts) {
        try {
          await window.signflow.kokoro.synthesize(a as never);
          out.push('accepted');
        } catch (err) {
          out.push(String((err as Error).message));
        }
      }
      try {
        await window.signflow.kokoro.cancel(['ok', 42] as never);
        out.push('accepted');
      } catch (err) {
        out.push(String((err as Error).message));
      }
      return out;
    });
    expect(errors).toHaveLength(6);
    for (const e of errors) expect(e).toMatch(/Kokoro|Invalid/);
    expect(errors.some((e) => e === 'accepted')).toBe(false);
  });

  test('only the main window may use Kokoro (the captions overlay is refused)', async () => {
    const { app, page } = ctx;
    await go(page, 'Live');
    const opened = app.waitForEvent('window');
    await page.getByTestId('captions-toggle').click();
    const captions = await opened;
    await captions.waitForLoadState('domcontentloaded');
    const result = await captions.evaluate(async () => {
      const out: string[] = [];
      for (const call of [
        () => window.signflow.kokoro.status(),
        () => window.signflow.kokoro.synthesize({ id: 'x', text: 'Hi.', voice: 'af_heart', speed: 1 }),
        () => window.signflow.kokoro.release(),
      ]) {
        try {
          await call();
          out.push('accepted');
        } catch (err) {
          out.push(String((err as Error).message));
        }
      }
      return out;
    });
    for (const r of result) expect(r).toMatch(/Blocked IPC "kokoro:/);
    await expect(page.evaluate(() => window.signflow.kokoro.status())).resolves.toMatchObject({ state: 'missing' });
    await captions.getByRole('button', { name: 'Close captions' }).click();
  });
});

test.describe('Kokoro: real model', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!modelInstalled, `Kokoro model not installed in ${installedRoot} (run npm run kokoro:install)`);
  let ctx: Awaited<ReturnType<typeof launch>>;

  test.beforeAll(async () => {
    ctx = await launch(installedRoot);
  });
  test.afterAll(async () => {
    await ctx?.app.close();
    if (ctx) rmSync(ctx.userData, { recursive: true, force: true });
  });

  test('loads, speaks the Test voice phrase, then only the confirmed text', async () => {
    test.setTimeout(90_000);
    const { page, logs } = ctx;
    await go(page, 'Settings');
    const selectedAt = Date.now();
    await choose(page, 'Speech engine', 'Kokoro — Local Neural Voice');
    await expect(page.getByTestId('kokoro-status')).toContainText('Ready', { timeout: 60_000 });
    const readyAfterMs = Date.now() - selectedAt;
    await choose(page, 'Kokoro voice', 'Bella');
    await choose(page, 'Kokoro voice', 'Heart');
    await auditAccessibility(page, 'Settings › Speech (Kokoro ready)');

    const clickedAt = Date.now();
    await page.getByRole('button', { name: 'Test voice' }).click();
    await expect.poll(() => logs.find((l) => l.startsWith('[kokoro] sentence 1:')), { timeout: 15_000 }).toBeTruthy();
    const startedAfterMs = Date.now() - clickedAt;
    await expect(page.getByTestId('voice-in-use-pill')).toHaveText('Heart · Kokoro (on-device neural)');
    await expect(page.getByTestId('notice-toast')).toHaveCount(0);

    // A draft on screen, edited, then discarded: nothing is synthesized.
    await go(page, 'Live');
    const before = logs.filter((l) => l.startsWith('[kokoro]')).length;
    await page.getByRole('button', { name: 'Start camera' }).click();
    const draft = page.getByTestId('draft-text');
    await expect(draft).toBeVisible({ timeout: 20_000 });
    await draft.fill('This draft is edited but never confirmed.');
    await page.waitForTimeout(1500);
    expect(logs.filter((l) => l.startsWith('[kokoro]')).length).toBe(before);

    // Confirm with Speak: exactly the confirmed text is synthesized (two sentences, two chunks).
    await draft.fill('I am allergic to penicillin. I have never smoked.');
    await page.getByRole('button', { name: /^Speak/ }).click();
    await expect(page.getByTestId('confirm-toast')).toContainText('Spoken');
    await expect.poll(() => logs.filter((l) => l.startsWith('[kokoro] sentence 2:')).length, { timeout: 15_000 }).toBe(1);
    const confirmed = logs.filter((l) => l.startsWith('[kokoro]')).slice(-2);
    expect(confirmed[0]).toContain('28 chars'); // "I am allergic to penicillin."
    expect(confirmed[1]).toContain('20 chars'); // "I have never smoked."

    console.log(`[kokoro e2e] ready ${readyAfterMs} ms after selecting; Test voice playing ${startedAfterMs} ms after click (incl. Playwright overhead)`);
    for (const l of logs.filter((x) => x.startsWith('[kokoro]'))) console.log(`[kokoro e2e] ${l}`);
    expect(ctx.requests).toEqual([]);
  });

  const kokoroProcess = (app: ElectronApplication) =>
    app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().some((m) => m.serviceName === 'SignFlow Kokoro voice' || m.name === 'SignFlow Kokoro voice'));

  test('Stop: nothing stale plays, whether stopped during synthesis or mid-sentence', async () => {
    test.setTimeout(60_000);
    const { page, logs } = ctx;
    const sentences = () => logs.filter((l) => l.startsWith('[kokoro] sentence')).length;
    const speak = async (text: string) => {
      await go(page, 'Live');
      const draft = page.getByTestId('draft-text');
      await expect(draft).toBeVisible({ timeout: 20_000 });
      await draft.fill(text);
      await page.getByRole('button', { name: /^Speak/ }).click();
      await go(page, 'Workspace');
    };

    // 1. Stop before any audio exists.
    let before = sentences();
    await speak('My doctor said I should take this twice a day. Please call the clinic tomorrow. Thank you.');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByTestId('speech-state')).toHaveText('Idle');
    await page.waitForTimeout(4000);
    expect(sentences()).toBe(before);

    // 2. Stop while sentence 1 plays: sentences 2 and 3 (already synthesizing or queued) never play.
    before = sentences();
    await speak('I am allergic to penicillin. I have never smoked. My appointment is tomorrow at three.');
    await expect.poll(sentences, { timeout: 15_000 }).toBe(before + 1);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByTestId('speech-state')).toHaveText('Idle');
    await page.waitForTimeout(5000);
    expect(sentences()).toBe(before + 1);
    await expect(page.getByTestId('notice-toast')).toHaveCount(0); // a stop is not a failure: no fallback voice
  });

  test('switching to the system voice frees the Kokoro process; switching back reloads it', async () => {
    test.setTimeout(60_000);
    const { app, page } = ctx;
    expect(await kokoroProcess(app)).toBe(true);
    await go(page, 'Settings');
    await choose(page, 'Speech engine', 'System voice');
    await expect.poll(() => kokoroProcess(app), { timeout: 10_000 }).toBe(false);
    await choose(page, 'Speech engine', 'Kokoro — Local Neural Voice');
    await expect(page.getByTestId('kokoro-status')).toContainText('Ready', { timeout: 60_000 });
    expect(await kokoroProcess(app)).toBe(true);
  });

  test('the voice engine never even tried to reach the network', () => {
    expect(ctx.mainOutput.join('')).not.toContain('blocked a network request');
    expect(ctx.requests).toEqual([]);
  });
});
