/**
 * Small PCM helpers for local speech (pure functions, no Node or DOM APIs).
 */

export interface TrimOptions {
  /** Absolute amplitude treated as silence. */
  threshold?: number;
  /** Silence kept before the first sound. */
  leadMs?: number;
  /** Silence kept after the last sound. */
  trailMs?: number;
  /** Fade applied at the cut points so trimming never clicks. */
  fadeMs?: number;
}

/**
 * Kokoro pads every clip with ~0.3-0.45 s of silence before the speech starts.
 * Trimming it makes speech start that much sooner after the user confirms.
 * Returns a new array; an all-silent clip comes back empty.
 */
export function trimSilence(samples: Float32Array, sampleRate: number, opts: TrimOptions = {}): Float32Array {
  const { threshold = 0.01, leadMs = 40, trailMs = 150, fadeMs = 5 } = opts;
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return new Float32Array(0);
  const start = Math.max(0, first - Math.round((leadMs / 1000) * sampleRate));
  const end = Math.min(samples.length, last + 1 + Math.round((trailMs / 1000) * sampleRate));
  const out = samples.slice(start, end);
  const fade = Math.min(Math.round((fadeMs / 1000) * sampleRate), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i]! *= g;
    out[out.length - 1 - i]! *= g;
  }
  return out;
}

/** Mono 16-bit PCM WAV (RIFF), the most widely playable format for an <audio> element. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/**
 * Split confirmed text into sentence-sized chunks so the first one can play
 * while the next is synthesized. Long sentences are split at commas, then at
 * spaces, so no chunk exceeds `maxChars` (Kokoro truncates very long input).
 */
export function splitForSpeech(text: string, maxChars = 220): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      chunks.push(sentence);
      continue;
    }
    let current = '';
    for (const part of sentence.split(/(?<=[,;:])\s+/)) {
      for (const piece of part.length > maxChars ? splitAtSpaces(part, maxChars) : [part]) {
        if (!current) current = piece;
        else if (current.length + 1 + piece.length <= maxChars) current += ` ${piece}`;
        else {
          chunks.push(current);
          current = piece;
        }
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

function splitAtSpaces(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + 1 + word.length > maxChars) {
      out.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) out.push(current);
  return out.flatMap((s) => (s.length > maxChars ? (s.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? []) : [s]));
}
