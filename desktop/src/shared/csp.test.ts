// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name ?? '', values];
    }),
  );
}

describe('buildCsp', () => {
  it('production policy never allows inline or eval scripts', () => {
    const d = directives(buildCsp('production'));
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(d.get('style-src')).toEqual(["'self'"]);
    expect(buildCsp('production')).not.toMatch(/unsafe-eval/);
  });

  it('locks down objects, frames, base-uri, and forms', () => {
    const d = directives(buildCsp('production'));
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('frame-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
  });

  it('production connect-src only allows self and the backend', () => {
    const connect = directives(buildCsp('production')).get('connect-src') ?? [];
    expect(connect).toContain("'self'");
    expect(connect.every((s) => s === "'self'" || s.includes('localhost:8000'))).toBe(true);
  });

  it('development policy relaxes only what Vite HMR needs', () => {
    const d = directives(buildCsp('development'));
    expect(d.get('script-src')).toContain("'unsafe-inline'");
    expect(buildCsp('development')).not.toMatch(/unsafe-eval/);
  });
});
