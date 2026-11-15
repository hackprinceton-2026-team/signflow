// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  decodeKokoroError,
  encodeKokoroError,
  isKokoroStatus,
  KOKORO_MAX_TEXT_CHARS,
  KOKORO_MODEL_FILES,
  KOKORO_MODEL_REVISION,
  KOKORO_VOICES,
  kokoroFileUrl,
  resolveKokoroVoice,
  validateKokoroRequestId,
  validateKokoroSynthesize,
} from './kokoro';

const ok = { id: 'abc-123', text: '  I have never smoked.  ', voice: 'af_heart', speed: 1 };

describe('Kokoro voices', () => {
  it('offers Heart (default), Bella and Michael', () => {
    expect(KOKORO_VOICES.map((v) => v.id)).toEqual(['af_heart', 'af_bella', 'am_michael']);
    expect(resolveKokoroVoice(undefined).id).toBe('af_heart');
    expect(resolveKokoroVoice('am_michael').name).toBe('Michael');
    expect(resolveKokoroVoice('Ruth').id).toBe('af_heart');
  });
});

describe('model manifest', () => {
  it('pins one upstream revision, over HTTPS, with a SHA-256 for every file', () => {
    expect(KOKORO_MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
    for (const f of KOKORO_MODEL_FILES) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(kokoroFileUrl(f.path)).toBe(`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_MODEL_REVISION}/${f.path}`);
    }
    expect(KOKORO_MODEL_FILES.map((f) => f.path)).toContain('onnx/model.onnx');
  });
});

describe('validateKokoroSynthesize (renderer input is untrusted)', () => {
  it('accepts a well-formed request, trimming text and clamping speed', () => {
    expect(validateKokoroSynthesize(ok)).toEqual({ id: 'abc-123', text: 'I have never smoked.', voice: 'af_heart', speed: 1 });
    expect(validateKokoroSynthesize({ ...ok, speed: 9 }).speed).toBe(2);
    expect(validateKokoroSynthesize({ ...ok, speed: 0.1 }).speed).toBe(0.5);
  });

  it.each([
    ['not an object', 'hello'],
    ['empty text', { ...ok, text: '   ' }],
    ['text too long', { ...ok, text: 'a'.repeat(KOKORO_MAX_TEXT_CHARS + 1) }],
    ['non-string text', { ...ok, text: 42 }],
    ['unknown voice', { ...ok, voice: 'af_sky' }],
    ['NaN speed', { ...ok, speed: Number.NaN }],
    ['string speed', { ...ok, speed: '1' }],
    ['bad id', { ...ok, id: '../../etc' }],
  ])('rejects %s', (_label, value) => {
    expect(() => validateKokoroSynthesize(value)).toThrow();
  });

  it('validates cancel ids', () => {
    expect(validateKokoroRequestId('a_b-1')).toBe('a_b-1');
    expect(() => validateKokoroRequestId('x'.repeat(65))).toThrow();
    expect(() => validateKokoroRequestId(5)).toThrow();
  });
});

describe('coded errors across IPC', () => {
  it('round-trips the code even inside Electron’s "Error invoking remote method" wrapper', () => {
    const wrapped = `Error invoking remote method 'kokoro:synthesize': Error: ${encodeKokoroError('missing', 'Not installed. Run x')}`;
    expect(decodeKokoroError(wrapped)).toEqual({ code: 'missing', message: 'Not installed. Run x' });
    expect(decodeKokoroError('something else')).toEqual({ code: 'unknown', message: 'something else' });
  });

  it('recognizes valid statuses only', () => {
    expect(isKokoroStatus({ state: 'ready', loadMs: 300 })).toBe(true);
    expect(isKokoroStatus({ state: 'missing', message: 'x' })).toBe(true);
    expect(isKokoroStatus({ state: 'great' })).toBe(false);
    expect(isKokoroStatus({ state: 'ready', loadMs: '3' })).toBe(false);
    expect(isKokoroStatus(null)).toBe(false);
  });
});
