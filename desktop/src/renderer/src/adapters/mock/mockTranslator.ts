import { newId } from '../emitter';
import type { EnglishDraft, RecognizedSign, Translator } from '../types';

/**
 * Rule-based gloss → English, standing in for the backend/LLM translator.
 * Longest phrase match wins; anything unknown falls back to the lowercased gloss.
 */
const PHRASES: readonly [readonly string[], string][] = [
  [['NICE', 'MEET', 'YOU'], 'nice to meet you'],
  [['I', 'LEARN', 'SIGN'], 'I am learning sign language'],
  [['WHERE', 'BATHROOM'], 'where is the bathroom'],
  [['PLEASE', 'REPEAT'], 'please repeat that'],
  [['HOW', 'YOU'], 'how are you'],
  [['WHAT', 'NAME'], 'what is your name'],
  [['MY', 'NAME'], 'my name is'],
  [['THANK-YOU'], 'thank you'],
  [['HELLO'], 'hello'],
  [['HI'], 'hi'],
  [['I'], 'I'],
  [['ME'], 'I'],
  [['YES'], 'yes'],
  [['NO'], 'no'],
];

const QUESTION_WORDS = new Set(['WHO', 'WHAT', 'WHERE', 'WHEN', 'WHY', 'HOW', 'WHICH']);
const GREETINGS = new Set(['hello', 'hi']);

export function glossesToEnglish(glosses: readonly string[]): string {
  const words: string[] = [];
  let i = 0;
  while (i < glosses.length) {
    const match = PHRASES.find(([pattern]) => pattern.every((g, k) => glosses[i + k] === g));
    if (match) {
      words.push(match[1]);
      i += match[0].length;
    } else {
      words.push((glosses[i] ?? '').toLowerCase().replace(/-/g, ' '));
      i += 1;
    }
  }

  const parts = words.filter(Boolean);
  if (parts.length === 0) return '';

  // "hello nice to meet you" -> "hello, nice to meet you"
  if (parts.length > 1 && GREETINGS.has(parts[0] ?? '')) parts[0] = `${parts[0]},`;

  let text = parts.join(' ');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const isQuestion = glosses.some((g) => QUESTION_WORDS.has(g));
  return `${text}${isQuestion ? '?' : '.'}`;
}

export interface MockTranslatorOptions {
  latencyMs?: number;
  /** Force failures, for testing error UI. */
  failWith?: string;
}

export class MockTranslator implements Translator {
  readonly name = 'Mock translator';

  constructor(private readonly opts: MockTranslatorOptions = {}) {}

  async translate(signs: readonly RecognizedSign[], { signal }: { signal?: AbortSignal } = {}): Promise<EnglishDraft> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const t = setTimeout(resolve, this.opts.latencyMs ?? 250);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });

    if (this.opts.failWith) throw new Error(this.opts.failWith);

    const glosses = signs.map((s) => s.gloss);
    const confidence = signs.length ? signs.reduce((sum, s) => sum + s.confidence, 0) / signs.length : 0;
    return {
      id: newId(),
      text: glossesToEnglish(glosses),
      signIds: signs.map((s) => s.id),
      glosses,
      confidence: Math.round(confidence * 100) / 100,
      createdAt: Date.now(),
    };
  }
}
