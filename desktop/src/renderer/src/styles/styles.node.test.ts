// @vitest-environment node
/**
 * Guards for the stylesheets. jsdom doesn't apply CSS, so a broken stylesheet
 * would otherwise pass every component test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = import.meta.dirname;
const SHEETS = [
  ...readdirSync(DIR).filter((f) => f.endsWith('.css')).map((f) => join(DIR, f)),
  join(DIR, '..', 'captions', 'captions.css'),
];
const read = (p: string) => readFileSync(p, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties defined anywhere (tokens plus component-local ones like --btn-bg). */
const defined = new Set(SHEETS.flatMap((p) => [...stripComments(read(p)).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!)));

describe.each(SHEETS.map((p) => [p.split('/').slice(-2).join('/'), p]))('%s', (_name, path) => {
  const css = stripComments(read(path));

  it('stays within a sane size budget', () => {
    expect(css.length).toBeLessThan(48_000);
  });

  it('has balanced braces', () => {
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('only uses custom properties that are defined', () => {
    const used = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!);
    expect(used.filter((v) => !defined.has(v))).toEqual([]);
  });
});
