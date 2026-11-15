// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { isTrustedRendererUrl, resolveInside } from './trust';

const root = '/app/out/renderer';

describe('resolveInside', () => {
  it('resolves normal asset paths inside the root', () => {
    expect(resolveInside(root, '/index.html')).toBe(join(root, 'index.html'));
    expect(resolveInside(root, '/assets/app-123.js')).toBe(join(root, 'assets/app-123.js'));
  });

  it('blocks parent-directory traversal', () => {
    expect(resolveInside(root, '/../main/index.js')).toBeNull();
    expect(resolveInside(root, '/assets/../../../etc/passwd')).toBeNull();
  });

  it('blocks URL-encoded traversal', () => {
    expect(resolveInside(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveInside(root, '/..%2fmain%2findex.js')).toBeNull();
  });

  it('rejects malformed encoding and NUL bytes', () => {
    expect(resolveInside(root, '/%E0%A4%A')).toBeNull();
    expect(resolveInside(root, '/index.html%00.png')).toBeNull();
  });

  it('rejects the root directory itself', () => {
    expect(resolveInside(root, '/')).toBeNull();
  });
});

describe('isTrustedRendererUrl', () => {
  const prod = { appScheme: 'app', appHost: 'signflow' };
  const dev = { ...prod, devUrl: 'http://localhost:5173' };

  it('trusts our app:// pages (custom schemes have origin "null" in WHATWG URL)', () => {
    expect(new URL('app://signflow/index.html').origin).toBe('null');
    expect(isTrustedRendererUrl('app://signflow/index.html', prod)).toBe(true);
    expect(isTrustedRendererUrl('app://signflow/captions.html#x', prod)).toBe(true);
  });

  it('rejects other hosts, schemes, and credentials tricks', () => {
    expect(isTrustedRendererUrl('app://evil/index.html', prod)).toBe(false);
    expect(isTrustedRendererUrl('app://signflow.evil.com/', prod)).toBe(false);
    expect(isTrustedRendererUrl('app://user:pw@signflow/', prod)).toBe(false);
    expect(isTrustedRendererUrl('file:///etc/passwd', prod)).toBe(false);
    expect(isTrustedRendererUrl('https://example.com', prod)).toBe(false);
  });

  it('rejects empty and malformed input', () => {
    expect(isTrustedRendererUrl(undefined, prod)).toBe(false);
    expect(isTrustedRendererUrl('', prod)).toBe(false);
    expect(isTrustedRendererUrl('not a url', prod)).toBe(false);
  });

  it('trusts the Vite dev server only when a dev URL is configured', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/index.html', prod)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/index.html', dev)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/index.html', dev)).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', dev)).toBe(false);
  });
});
