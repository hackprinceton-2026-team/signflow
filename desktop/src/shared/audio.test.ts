// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encodeWav16, splitForSpeech, trimSilence } from './audio';

const SR = 24_000;

function clip(leadS: number, toneS: number, trailS: number): Float32Array {
  const out = new Float32Array(Math.round((leadS + toneS + trailS) * SR));
  const start = Math.round(leadS * SR);
  for (let i = 0; i < Math.round(toneS * SR); i++) out[start + i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}

describe('trimSilence', () => {
  it("cuts Kokoro's ~0.35 s of leading silence down to 40 ms, and the tail to 150 ms", () => {
    const trimmed = trimSilence(clip(0.35, 1, 0.5), SR);
    expect(trimmed.length / SR).toBeCloseTo(0.04 + 1 + 0.15, 2);
  });

  it('fades the cut edges so trimming never clicks', () => {
    const trimmed = trimSilence(clip(0, 1, 0), SR);
    expect(trimmed[0]).toBe(0);
    expect(Math.abs(trimmed.at(-1)!)).toBeLessThan(0.01);
  });

  it('returns an empty clip for silence, and never mutates the input', () => {
    expect(trimSilence(new Float32Array(SR), SR)).toHaveLength(0);
    const input = clip(0.1, 0.2, 0.1);
    const copy = input.slice();
    trimSilence(input, SR);
    expect(input).toEqual(copy);
  });
});

describe('encodeWav16', () => {
  it('writes a valid mono 16-bit PCM RIFF header and clamps samples', () => {
    const wav = encodeWav16(new Float32Array([0, 1, -1, 2, -2, 0.5]), SR);
    const view = new DataView(wav.buffer);
    const ascii = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 8)).toBe('WAVEfmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SR);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    const samples = [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

describe('splitForSpeech', () => {
  it('splits confirmed text into sentences and normalizes whitespace', () => {
    expect(splitForSpeech('  I am allergic to penicillin.   I have never smoked.\nThanks! ')).toEqual([
      'I am allergic to penicillin.',
      'I have never smoked.',
      'Thanks!',
    ]);
  });

  it("keeps a single sentence (and abbreviations-free text) whole, and drops empty input", () => {
    expect(splitForSpeech("My doctor's appointment is tomorrow at three.")).toEqual(["My doctor's appointment is tomorrow at three."]);
    expect(splitForSpeech('   ')).toEqual([]);
  });

  it('breaks an over-long sentence at commas, then spaces, never exceeding the limit or losing words', () => {
    const long = `${'word '.repeat(30).trim()}, ${'more '.repeat(30).trim()}`;
    const chunks = splitForSpeech(long, 80);
    expect(chunks.every((c) => c.length <= 80)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long);
    expect(splitForSpeech('x'.repeat(200), 80).join('')).toBe('x'.repeat(200));
  });
});
