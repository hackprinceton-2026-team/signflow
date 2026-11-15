// @vitest-environment node
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installNetworkGuard } from './networkGuard';

const saved = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };

describe('installNetworkGuard (Kokoro utility process)', () => {
  const blocked: string[] = [];
  beforeEach(() => {
    blocked.length = 0;
    installNetworkGuard((url) => blocked.push(url));
  });
  afterEach(() => {
    globalThis.fetch = saved.fetch;
    Object.assign(http, { request: saved.httpRequest, get: saved.httpGet });
    Object.assign(https, { request: saved.httpsRequest, get: saved.httpsGet });
  });

  it('blocks every http(s) fetch: user text and model loads never leave the device', async () => {
    await expect(fetch('https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin')).rejects.toThrow(/blocks network access/);
    await expect(fetch(new URL('http://localhost:8000/speak'), { method: 'POST', body: 'I have never smoked.' })).rejects.toThrow();
    await expect(fetch(new Request('https://api.example.com/tts'))).rejects.toThrow();
    expect(blocked).toEqual([
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin',
      'http://localhost:8000/speak',
      'https://api.example.com/tts',
    ]);
  });

  it('blocks node:http and node:https too', () => {
    const spy = vi.fn();
    expect(() => http.request('http://example.com', spy)).toThrow(/blocks network access/);
    expect(() => https.get('https://example.com', spy)).toThrow(/blocks network access/);
    expect(spy).not.toHaveBeenCalled();
    expect(blocked).toEqual(['http://example.com', 'https://example.com']);
  });

  it('still allows local file: URLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    try {
      const file = join(dir, 'config.json');
      writeFileSync(file, '{"model_type":"style_text_to_speech_2"}');
      // Node's fetch doesn't support file: itself; what matters is the guard passes it through untouched.
      const res = await fetch(pathToFileURL(file)).catch((err: Error) => err);
      expect(String(res)).not.toMatch(/blocks network access/);
      expect(blocked).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
