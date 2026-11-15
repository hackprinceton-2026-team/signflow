import axeCore from 'axe-core';
import { expect, type Page } from '@playwright/test';

/**
 * axe-core (WCAG 2.1 A/AA) inside the real Electron app. Injected through the
 * DevTools-protocol evaluate (not a <script> tag), so the app's CSP is unchanged.
 * Serious and critical violations fail.
 */
export async function auditAccessibility(target: Page, label: string): Promise<void> {
  await target.waitForTimeout(500); // let entrance animations settle before measuring contrast
  if (!(await target.evaluate(() => 'axe' in window))) await target.evaluate(axeCore.source);
  const results = await target.evaluate(() =>
    (window as unknown as { axe: typeof axeCore }).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'],
    }),
  );
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = blocking.map((v) => `${v.impact} ${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join('\n    ')}`);
  expect(report, `${label}\n${report.join('\n')}`).toEqual([]);
}
