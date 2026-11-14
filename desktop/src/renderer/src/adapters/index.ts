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
export function createAdapters(mode: AdapterMode = 'mock'): Adapters {
  switch (mode) {
    case 'mock':
    default:
      return {
        recognizer: new MockSignRecognizer({ seed: Date.now() % 100_000 }),
        translator: new MockTranslator(),
        speech: hasSpeechSynthesis() ? new WebSpeechEngine() : new MockSpeechEngine(),
      };
  }
}

function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export type * from './types';
