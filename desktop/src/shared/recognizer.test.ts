// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  normalizeGloss,
  parseRecognizerMessage,
  RECOGNIZER_DEFAULT_PORT,
  RECOGNIZER_MAX_MESSAGE_CHARS,
  recognizerPort,
  toMillis,
  validateRecognizerStart,
  type RecognizerEvent,
} from './recognizer';

const NOW = 1_794_708_460_000; // ms
const T = NOW / 1000 - 2; // a sign that ended 2 s ago, in the recognizer's seconds

const parse = (msg: unknown) => parseRecognizerMessage(typeof msg === 'string' ? msg : JSON.stringify(msg), NOW);
const ok = (msg: unknown): RecognizerEvent => {
  const r = parse(msg);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  if (!('event' in r)) throw new Error('expected an event, got a preview');
  return r.event;
};

describe('14-sign demo model messages (the recognizer default, as in its README)', () => {
  it('normalizes a sign: seconds → ms, stable id, alternatives without the sign itself', () => {
    const e = ok({ type: 'sign', sign: 'HELP', confidence: 0.91, candidates: [['HELP', 0.91], ['STOP', 0.05], ['DOCTOR', 0.02]], ts: T });
    expect(e).toEqual({
      type: 'sign',
      sign: {
        id: `asl-${NOW - 2000}-HELP`,
        gloss: 'HELP',
        confidence: 0.91,
        ts: NOW - 2000,
        final: true,
        uncertain: false,
        alternatives: [
          { gloss: 'STOP', confidence: 0.05 },
          { gloss: 'DOCTOR', confidence: 0.02 },
        ],
        model: 'demo14',
      },
    });
  });

  it('maps THANKYOU to SignFlow’s THANK-YOU, in the sign and the candidates', () => {
    const e = ok({ type: 'sign', sign: 'THANKYOU', confidence: 0.8, candidates: [['THANKYOU', 0.8], ['GIVE', 0.1]], ts: T });
    expect(e.type === 'sign' && e.sign.gloss).toBe('THANK-YOU');
    expect(e.type === 'sign' && e.sign.alternatives).toEqual([{ gloss: 'GIVE', confidence: 0.1 }]);
  });

  it('accepts a sign without candidates', () => {
    expect(ok({ type: 'sign', sign: 'YES', confidence: 0.7, ts: T })).toMatchObject({ sign: { gloss: 'YES', alternatives: [] } });
  });

  it('the same message twice gets the same id (so it can be dropped as a duplicate)', () => {
    const msg = { type: 'sign', sign: 'NO', confidence: 0.9, ts: T };
    const a = ok(msg);
    const b = ok(msg);
    expect(a.type === 'sign' && b.type === 'sign' && a.sign.id === b.sign.id).toBe(true);
  });

  it('end_of_sentence', () => {
    expect(ok({ type: 'end_of_sentence', signs: ['HELP', 'DOCTOR'], ts: T })).toEqual({ type: 'sentence-end', ts: NOW - 2000, model: 'demo14' });
  });
});

describe('116-sign keyword model messages (opt-in)', () => {
  it('a confident top-1 becomes the sign, with the calibrated probability as confidence', () => {
    const e = ok({
      type: 'sign',
      candidates: [['HEADACHE', 0.62], ['HOT', 0.14], ['SICK', 0.07], ['COLD', 0.05], ['MEDICINE', 0.04]],
      top1: 'HEADACHE',
      confident: true,
      ts: T,
    });
    expect(e).toMatchObject({
      sign: { gloss: 'HEADACHE', confidence: 0.62, uncertain: false, model: 'keyword116' },
    });
    expect(e.type === 'sign' && e.sign.alternatives.map((a) => a.gloss)).toEqual(['HOT', 'SICK', 'COLD', 'MEDICINE']);
  });

  it('a not-confident top-1 is marked uncertain, never silently promoted (recorded: SICK → HELP 0.19)', () => {
    const e = ok({
      type: 'sign',
      candidates: [['HELP', 0.19], ['HOW', 0.08], ['AGAIN', 0.08], ['THIN', 0.07], ['STOP', 0.06]],
      top1: 'HELP',
      confident: false,
      ts: T,
    });
    expect(e).toMatchObject({ sign: { gloss: 'HELP', confidence: 0.19, uncertain: true } });
  });

  it('end_of_sentence with per-sign confident flags', () => {
    expect(ok({ type: 'end_of_sentence', signs: ['HEADACHE', 'MEDICINE'], confident: [true, false], ts: T })).toMatchObject({
      model: 'keyword116',
    });
  });

  it.each([
    ['top1 not among the candidates', { type: 'sign', candidates: [['HOT', 0.5]], top1: 'HEADACHE', confident: true, ts: T }],
    ['no candidates', { type: 'sign', candidates: [], top1: 'HEADACHE', confident: true, ts: T }],
    ['confident is not a boolean', { type: 'sign', candidates: [['HOT', 0.5]], top1: 'HOT', confident: 'yes', ts: T }],
  ])('rejects %s', (_label, msg) => {
    expect(parse(msg).ok).toBe(false);
  });
});

describe('untrusted input', () => {
  it.each([
    ['not JSON', '{"type": "sign", '],
    ['a JSON array', '[1,2]'],
    ['null', 'null'],
    ['an unknown type', { type: 'frame', jpeg: '...' }],
    ['a missing sign', { type: 'sign', confidence: 0.9, ts: T }],
    ['confidence above 1', { type: 'sign', sign: 'HELP', confidence: 1.5, ts: T }],
    ['confidence as a string', { type: 'sign', sign: 'HELP', confidence: '0.9', ts: T }],
    ['a gloss with spaces and punctuation', { type: 'sign', sign: 'HELP; rm -rf /', confidence: 0.9, ts: T }],
    ['an over-long gloss', { type: 'sign', sign: 'A'.repeat(41), confidence: 0.9, ts: T }],
    ['the non-sign class', { type: 'sign', sign: 'NOTHING', confidence: 0.9, ts: T }],
    ['malformed candidates', { type: 'sign', sign: 'HELP', confidence: 0.9, candidates: [['HELP']], ts: T }],
    ['too many candidates', { type: 'sign', sign: 'HELP', confidence: 0.9, candidates: Array(11).fill(['HELP', 0.1]), ts: T }],
  ])('drops %s', (_label, msg) => {
    expect(parse(msg).ok).toBe(false);
  });

  it('drops oversized messages before parsing them', () => {
    const big = JSON.stringify({ type: 'sign', sign: 'HELP', confidence: 0.9, pad: 'x'.repeat(RECOGNIZER_MAX_MESSAGE_CHARS) });
    expect(parse(big)).toEqual({ ok: false, reason: 'message too large' });
    expect(parseRecognizerMessage(new Uint8Array(4), NOW)).toEqual({ ok: false, reason: 'not a text message' });
  });

  it('drops a gloss it can’t use from the candidates but keeps the sign', () => {
    const e = ok({ type: 'sign', sign: 'HELP', confidence: 0.9, candidates: [['HELP', 0.9], ['NOTHING', 0.05], ['STOP', 0.05]], ts: T });
    expect(e.type === 'sign' && e.sign.alternatives).toEqual([{ gloss: 'STOP', confidence: 0.05 }]);
  });
});

describe('helpers', () => {
  it('normalizeGloss', () => {
    expect(normalizeGloss(' thank you ')).toBe('THANK-YOU');
    expect(normalizeGloss('THANKYOU')).toBe('THANK-YOU');
    expect(normalizeGloss('i_need')).toBe('I-NEED');
    expect(normalizeGloss('')).toBeNull();
    expect(normalizeGloss(42)).toBeNull();
  });

  it('toMillis: seconds to ms; an implausible clock is replaced by the receive time', () => {
    expect(toMillis(NOW / 1000 - 1.5, NOW)).toBe(NOW - 1500);
    expect(toMillis(1_700_000_000, NOW)).toBe(NOW); // a replayed recording from long ago
    expect(toMillis(NOW / 1000 + 3600, NOW)).toBe(NOW); // from the future
    expect(toMillis(NOW, NOW)).toBe(NOW); // milliseconds sent by mistake
    expect(toMillis('soon', NOW)).toBe(NOW);
  });

  it('validateRecognizerStart and recognizerPort', () => {
    expect(validateRecognizerStart({ allowKeyword: true })).toEqual({ allowKeyword: true });
    expect(() => validateRecognizerStart({ allowKeyword: 'yes' })).toThrow();
    expect(() => validateRecognizerStart(null)).toThrow();
    expect(recognizerPort(undefined)).toBe(RECOGNIZER_DEFAULT_PORT);
    expect(recognizerPort('9123')).toBe(9123);
    expect(recognizerPort('80')).toBe(RECOGNIZER_DEFAULT_PORT);
    expect(recognizerPort('abc')).toBe(RECOGNIZER_DEFAULT_PORT);
  });
});

describe('preview frames (SignFlow recognizer launcher)', () => {
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/';
  it('accepts a small JPEG with sane dimensions', () => {
    expect(parse({ type: 'preview', jpeg, width: 320, height: 180, ts: T })).toEqual({ ok: true, preview: { jpeg, width: 320, height: 180 } });
  });
  it.each([
    ['not a JPEG (PNG)', { type: 'preview', jpeg: 'iVBORw0KGgo=', width: 320, height: 180 }],
    ['not base64', { type: 'preview', jpeg: '/9j/<script>', width: 320, height: 180 }],
    ['bad dimensions', { type: 'preview', jpeg, width: 99999, height: 180 }],
    ['missing dimensions', { type: 'preview', jpeg }],
  ])('drops %s', (_label, msg) => {
    expect(parse(msg).ok).toBe(false);
  });
  it('only previews may be large; even they are capped', () => {
    const big = `/9j/${'A'.repeat(150_000)}`;
    expect(parse({ type: 'preview', jpeg: big, width: 320, height: 180 }).ok).toBe(true);
    expect(parse({ type: 'preview', jpeg: `/9j/${'A'.repeat(250_000)}`, width: 320, height: 180 })).toEqual({ ok: false, reason: 'message too large' });
  });
});
