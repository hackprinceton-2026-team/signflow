import { useCallback, useEffect, useState } from 'react';
import type { SpeechEngine, SpeechOptions, SpeechState, SpeechVoice } from '../adapters/types';
import { usePersistentState } from './usePersistentState';

export const DEFAULT_SPEECH_OPTIONS: SpeechOptions = { voiceId: undefined, rate: 1, pitch: 1, volume: 1 };

function isSpeechOptions(v: unknown): v is SpeechOptions {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['rate'] === 'number' &&
    typeof o['pitch'] === 'number' &&
    typeof o['volume'] === 'number' &&
    (o['voiceId'] === undefined || typeof o['voiceId'] === 'string')
  );
}

/** React state around a SpeechEngine: voices, playback state, persisted options. */
export function useSpeech(engine: SpeechEngine) {
  const [voices, setVoices] = useState<SpeechVoice[]>(() => engine.voices());
  const [state, setState] = useState<SpeechState>('idle');
  const [lastSpoken, setLastSpoken] = useState<string | null>(null);
  const [options, setOptions] = usePersistentState<SpeechOptions>(
    'signflow.speech',
    DEFAULT_SPEECH_OPTIONS,
    isSpeechOptions,
  );

  useEffect(() => {
    const offVoices = engine.onVoicesChanged(setVoices);
    const offState = engine.onState(setState);
    return () => {
      offVoices();
      offState();
      engine.cancel();
    };
  }, [engine]);

  // English voices first, then alphabetical.
  const sortedVoices = [...voices].sort((a, b) => {
    const ae = a.lang.startsWith('en') ? 0 : 1;
    const be = b.lang.startsWith('en') ? 0 : 1;
    return ae - be || a.name.localeCompare(b.name);
  });

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setLastSpoken(text);
      engine.speak(text, options);
    },
    [engine, options],
  );

  const updateOptions = useCallback(
    (patch: Partial<SpeechOptions>) => setOptions((prev) => ({ ...prev, ...patch })),
    [setOptions],
  );

  return {
    available: engine.available,
    engineName: engine.name,
    voices: sortedVoices,
    state,
    options,
    lastSpoken,
    speak,
    pause: useCallback(() => engine.pause(), [engine]),
    resume: useCallback(() => engine.resume(), [engine]),
    stop: useCallback(() => engine.cancel(), [engine]),
    updateOptions,
    resetOptions: useCallback(() => setOptions(DEFAULT_SPEECH_OPTIONS), [setOptions]),
  };
}

export type SpeechController = ReturnType<typeof useSpeech>;
