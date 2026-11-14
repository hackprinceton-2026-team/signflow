import { MockSignRecognizer } from './mock/mockRecognizer';
import { MockTranslator } from './mock/mockTranslator';
import { MockSpeechEngine, WebSpeechEngine } from './speech';
import type { Adapters } from './types';

export type AdapterMode = 'mock';

/**
 * Builds the adapter set the app runs with.
 *
 * Only `mock` exists today. When backend/ and ml/ expose the WebSocket in
 * docs/interfaces.md, add a `remote` mode here. No component needs to change.
 */
export function createAdapters(mode: AdapterMode = 'mock', opts: { silentSpeech?: boolean } = {}): Adapters {
  const speech = !opts.silentSpeech && hasSpeechSynthesis() ? new WebSpeechEngine() : new MockSpeechEngine();
  switch (mode) {
    case 'mock':
    default:
      return {
        recognizer: new MockSignRecognizer({ seed: Date.now() % 100_000 }),
        translator: new MockTranslator(),
        speech,
      };
  }
}

/** True when the main process launched us for automated tests. */
export function isE2eRun(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('e2e') === '1';
}

function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export type * from './types';
