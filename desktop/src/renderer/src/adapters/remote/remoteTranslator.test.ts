import { describe, expect, it } from 'vitest';
import { MAX_SIGNS_PER_REQUEST, RemoteTranslator } from './remoteTranslator';
import { createFakeBackend } from '../../test/fakeBackend';
import type { RecognizedSign } from '../types';

const sign = (gloss: string, confidence = 0.9, id = gloss): RecognizedSign => ({ id, gloss, confidence, ts: 0, final: true });

describe('RemoteTranslator', () => {
  it('sends glosses and context, and returns a draft (never audio)', async () => {
    const backend = createFakeBackend({ translate: () => "I've had a headache since yesterday." });
    const t = new RemoteTranslator(backend.client, 'medical');
    const draft = await t.translate([sign('HEADACHE', 0.8), sign('SINCE', 0.9), sign('YESTERDAY', 1)]);
    expect(backend.callsTo('/translate')).toEqual([
      { method: 'POST', path: '/translate', body: { raw_signs: ['HEADACHE', 'SINCE', 'YESTERDAY'], mode: 'medical' } },
    ]);
    expect(backend.callsTo('/speak')).toEqual([]);
    expect(draft).toMatchObject({
      text: "I've had a headache since yesterday.",
      glosses: ['HEADACHE', 'SINCE', 'YESTERDAY'],
      signIds: ['HEADACHE', 'SINCE', 'YESTERDAY'],
      confidence: 0.9,
    });
    expect(draft.id).toBeTruthy();
  });

  it('splits very long runs into requests the backend accepts', async () => {
    const backend = createFakeBackend({ translate: (g) => `part(${g.length})` });
    const signs = Array.from({ length: MAX_SIGNS_PER_REQUEST + 6 }, (_, i) => sign('HELLO', 0.9, `s${i}`));
    const draft = await new RemoteTranslator(backend.client).translate(signs);
    expect(backend.callsTo('/translate').map((c) => (c.body as { raw_signs: string[] }).raw_signs.length)).toEqual([64, 6]);
    expect(draft.text).toBe('part(64) part(6)');
    expect(draft.signIds).toHaveLength(70);
  });

  it('propagates backend errors with their user-facing message', async () => {
    const backend = createFakeBackend({ translationConfigured: false });
    await expect(new RemoteTranslator(backend.client).translate([sign('HELLO')])).rejects.toMatchObject({
      kind: 'not_configured',
      message: expect.stringContaining('GOOGLE_API_KEY'),
    });
  });
});
