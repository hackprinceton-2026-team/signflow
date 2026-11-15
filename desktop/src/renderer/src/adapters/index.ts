import { MockSignRecognizer } from './mock/mockRecognizer';
import { MockTranslator } from './mock/mockTranslator';
import { MockSpeechEngine, WebSpeechEngine } from './speech';
import type { Adapters } from './types';

/** Builds the demo (mock) adapter set. Live mode swaps in remote adapters; see app/useSignFlow. */
export type DemoAdapterMode = 'mock';

/**
 * The demo adapter set: mock recognizer + mock translator + system speech.
 * Live mode (connection.ts) replaces the translator and, optionally, speech with
 * the remote adapters in ./remote. The recognizer stays the demo one until the
 * backend or ml/ serves recognition.
 */
export function createAdapters(mode: DemoAdapterMode = 'mock', opts: { silentSpeech?: boolean } = {}): Adapters {
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

/** E2E runs are silent unless launched with SIGNFLOW_E2E_SPEECH=system (real system voices). */
export function isSilentE2eRun(): boolean {
  return isE2eRun() && new URLSearchParams(location.search).get('speech') !== 'system';
}

function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export type * from './types';
export { DEFAULT_CONNECTION, isConnectionSettings, type AdapterMode, type ConnectionSettings, type VoiceSource } from './connection';
export { BACKEND_URL, BackendError, createBackendClient, type BackendClient, type BackendErrorKind } from './remote/backendClient';
export { RemoteTranslator } from './remote/remoteTranslator';
export { CloudSpeechEngine, FallbackSpeechEngine } from './remote/cloudSpeech';
