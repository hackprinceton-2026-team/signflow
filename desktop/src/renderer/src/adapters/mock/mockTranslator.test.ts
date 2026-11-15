import { describe, expect, it, vi } from 'vitest';
import { glossesToEnglish, MockTranslator } from './mockTranslator';
import { DEMO_PHRASES } from './mockRecognizer';
import type { RecognizedSign } from '../types';

const sign = (gloss: string, confidence = 0.9): RecognizedSign => ({
  id: `id-${gloss}-${confidence}`,
  gloss,
  confidence,
  ts: 0,
  final: true,
});

describe('glossesToEnglish', () => {
  it.each([
    [['HELLO', 'NICE', 'MEET', 'YOU'], 'Hello, nice to meet you.'],
    [['HOW', 'YOU'], 'How are you?'],
    [['I', 'LEARN', 'SIGN'], 'I am learning sign language.'],
    [['WHERE', 'BATHROOM'], 'Where is the bathroom?'],
    [['I', 'NEED', 'HELP'], 'I need help.'],
    [['PLEASE', 'REPEAT'], 'Please repeat that.'],
    [['I', 'WANT', 'COFFEE'], 'I want coffee.'],
    [['THANK-YOU'], 'Thank you.'],
  ])('%j -> %s', (glosses, expected) => {
    expect(glossesToEnglish(glosses)).toBe(expected);
  });

  it('produces non-empty English for every demo phrase', () => {
    for (const phrase of DEMO_PHRASES) expect(glossesToEnglish(phrase)).toMatch(/^[A-Z].*[.?]$/);
  });

  it('falls back to lowercased glosses with hyphens as spaces', () => {
    expect(glossesToEnglish(['SIGN-NAME', 'GOOD'])).toBe('Sign name good.');
  });

  it('returns empty string for no glosses', () => {
    expect(glossesToEnglish([])).toBe('');
  });
});

describe('MockTranslator', () => {
  it('builds a draft with averaged confidence and source sign ids', async () => {
    vi.useFakeTimers();
    const t = new MockTranslator({ latencyMs: 100 });
    const signs = [sign('HOW', 0.8), sign('YOU', 0.9)];
    const p = t.translate(signs);
    await vi.advanceTimersByTimeAsync(100);
    const draft = await p;
    expect(draft.text).toBe('How are you?');
    expect(draft.confidence).toBe(0.85);
    expect(draft.signIds).toEqual(signs.map((s) => s.id));
    expect(draft.glosses).toEqual(['HOW', 'YOU']);
    vi.useRealTimers();
  });

  it('supports cancellation', async () => {
    const t = new MockTranslator({ latencyMs: 10_000 });
    const ctrl = new AbortController();
    const p = t.translate([sign('HELLO')], { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('can simulate backend failures', async () => {
    const t = new MockTranslator({ latencyMs: 0, failWith: 'backend down' });
    await expect(t.translate([sign('HELLO')])).rejects.toThrow('backend down');
  });
});
