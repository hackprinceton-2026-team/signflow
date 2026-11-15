/**
 * Automated accessibility audit (axe-core, WCAG 2.1 A/AA) of every screen in
 * the real Electron app. Serious and critical violations fail the run.
 *
 * axe is injected through Playwright's DevTools-protocol evaluation (not a
 * <script> tag), so the app's strict CSP stays exactly as shipped.
 * (@axe-core/playwright can't be used: it opens extra pages, which Electron
 * doesn't support.)
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { auditAccessibility as audit } from './support/axe';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'signflow-a11y-'));
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

const go = (label: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();

test('Live (camera off)', async () => {
  await audit(page, 'Live off');
});

test('Live with signs and a draft', async () => {
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByTestId('draft-text')).toBeVisible({ timeout: 15_000 });
  await audit(page, 'Live draft');
});

test('Workspace', async () => {
  test.setTimeout(60_000);
  await go('Workspace');
  // Always audit the low-confidence (struck-through) row style too: wait until the
  // demo recognizer has produced one (it does so at random, ~15% of signs).
  await expect(page.locator('.sign-rejected').first()).toBeVisible({ timeout: 45_000 });
  await audit(page, 'Workspace');
});

test('Notes', async () => {
  await go('Notes');
  await audit(page, 'Notes');
});

test('Settings', async () => {
  await go('Settings');
  await audit(page, 'Settings');
});

test('Focus Mode', async () => {
  await page.getByTestId('focus-enter').click();
  await expect(page.locator('.shell')).toHaveAttribute('data-focus', 'true');
  await audit(page, 'Focus Mode');
  await page.keyboard.press('Escape');
  await expect(page.locator('.shell')).not.toHaveAttribute('data-focus');
});

test('Floating captions window', async () => {
  const opened = app.waitForEvent('window');
  await page.getByTestId('captions-toggle').click();
  const captions = await opened;
  await captions.waitForLoadState('domcontentloaded');
  await audit(captions, 'Captions');
  await captions.getByRole('button', { name: 'Close captions' }).click();
});
