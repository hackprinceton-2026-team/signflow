import { describe, expect, it } from 'vitest';
import { checkFidelity, composeLocally, extractNumbers, glossToWords } from './realtime';

describe('glossToWords (Words mode)', () => {
  it.each([
    ['HELP', 'help'],
    ['THANK-YOU', 'thank you'],
    ['THANKYOU', 'thank you'],
    ['IX-1', 'I'],
    ['NOT-YET', 'not yet'],
    ['R-A-I', 'R A I'],
    ['#IF', 'if'],
    ['BATHROOM', 'bathroom'],
  ])('%s → %s', (gloss, words) => {
    expect(glossToWords(gloss)).toBe(words);
  });
});

describe('composeLocally (the non-AI fallback)', () => {
  it('keeps the signed words and order, adding no facts', () => {
    expect(composeLocally(['HELP', 'DOCTOR'])).toBe('Help doctor.');
    expect(composeLocally(['I', 'ALLERGIC', 'PENICILLIN'])).toBe('I allergic penicillin.');
  });
});

describe('extractNumbers', () => {
  it('reads digits, times and number words', () => {
    expect(extractNumbers('Take 2 pills at 3:00')).toEqual([2, 3]);
    expect(extractNumbers('three times a day')).toEqual([3]);
    expect(extractNumbers('at 3:30')).toEqual([3.5]);
  });
});

describe('checkFidelity (gate before auto-speaking a Gemini sentence)', () => {
  const ok = (glosses: string[], text: string) => expect(checkFidelity(glosses, text)).toEqual([]);
  const codes = (glosses: string[], text: string) => checkFidelity(glosses, text).map((f) => f.code);

  it('passes faithful sentences', () => {
    ok(['HELP', 'DOCTOR'], 'I need help from a doctor.');
    ok(['I', 'ALLERGIC', 'PENICILLIN'], 'I am allergic to penicillin.');
    ok(['I', 'NEVER', 'SMOKE'], 'I have never smoked.');
    ok(['APPOINTMENT', 'TOMORROW', 'THREE'], 'My appointment is tomorrow at three.');
    ok(['THANK-YOU'], 'Thank you.');
    ok(['WAIT'], 'One moment, please.'); // "one" as an article is not a quantity
  });

  it('holds a dropped or added negation', () => {
    expect(codes(['I', 'NOT', 'ALLERGIC'], 'I am allergic.')).toContain('negation_dropped');
    expect(codes(['I', 'SMOKE'], "I don't smoke.")).toContain('negation_added');
  });

  it('holds a changed, missing or invented number', () => {
    expect(codes(['TAKE', 'MEDICINE', 'TWO'], 'Take three pills of medicine.')).toEqual(['number_missing', 'number_added']);
    expect(codes(['APPOINTMENT', 'TOMORROW'], 'My appointment is tomorrow at 3.')).toEqual(['number_added']);
  });

  it('holds a missing or invented medical term', () => {
    expect(codes(['I', 'ALLERGIC', 'PENICILLIN'], 'I am allergic to medicine.')).toEqual(['term_missing', 'term_added']);
    expect(codes(['HEAD', 'HURT'], 'My head hurts and I need aspirin.')).toEqual(['term_added']);
  });

  it('holds an empty answer', () => {
    expect(codes(['HELP'], '  ')).toEqual(['empty']);
  });
});
