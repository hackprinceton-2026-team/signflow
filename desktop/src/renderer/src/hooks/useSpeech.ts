import { useCallback, useEffect, useState } from 'react';
import type { SpeechEngine, SpeechOptions, SpeechState, SpeechVoice, VoiceInUse } from '../adapters/types';
import { usePersistentState } from './usePersistentState';

/**
 * Natural playback: normal rate and pitch, full volume, the best installed
 * system voice, and the default cloud voice (Ruth, Amazon Polly Generative).
 */
export const DEFAULT_SPEECH_OPTIONS: SpeechOptions = { voiceId: undefined, cloudVoiceId: undefined, rate: 1, pitch: 1, volume: 1 };

function isSpeechOptions(v: unknown): v is SpeechOptions {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['rate'] === 'number' &&
    typeof o['pitch'] === 'number' &&
    typeof o['volume'] === 'number' &&
    (o['voiceId'] === undefined || typeof o['voiceId'] === 'string') &&
    (o['cloudVoiceId'] === undefined || typeof o['cloudVoiceId'] === 'string')
  );
}

/** React state around a SpeechEngine: voices, playback state, persisted options. */
export function useSpeech(engine: SpeechEngine) {
  // Voices and playback state are tracked per engine, so swapping engines at runtime
  // (demo ↔ live, system ↔ cloud voice) never shows the previous engine's values.
  const [voicesEntry, setVoicesEntry] = useState<{ engine: SpeechEngine; voices: SpeechVoice[] } | null>(null);
  const [stateEntry, setStateEntry] = useState<{ engine: SpeechEngine; state: SpeechState } | null>(null);
  const [voiceInUseEntry, setVoiceInUseEntry] = useState<{ engine: SpeechEngine; voice: VoiceInUse } | null>(null);
  const voices = voicesEntry?.engine === engine ? voicesEntry.voices : engine.voices();
  const state: SpeechState = stateEntry?.engine === engine ? stateEntry.state : 'idle';
  /** The voice that actually spoke last with this engine (null until something is spoken). */
  const voiceInUse = voiceInUseEntry?.engine === engine ? voiceInUseEntry.voice : null;
  const [lastSpoken, setLastSpoken] = useState<string | null>(null);
  const [options, setOptions] = usePersistentState<SpeechOptions>(
    'signflow.speech',
    DEFAULT_SPEECH_OPTIONS,
    isSpeechOptions,
  );

  useEffect(() => {
    const offVoices = engine.onVoicesChanged((v) => setVoicesEntry({ engine, voices: v }));
    const offState = engine.onState((st) => setStateEntry({ engine, state: st }));
    const offVoiceInUse = engine.onVoiceInUse?.((voice) => setVoiceInUseEntry({ engine, voice }));
    return () => {
      offVoices();
      offState();
      offVoiceInUse?.();
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

  /** Speak a fixed sample (Test voice). Not user text, so "Speak last" is unaffected. */
  const preview = useCallback((text: string) => engine.speak(text, options), [engine, options]);

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
    voiceInUse,
    speak,
    preview,
    pause: useCallback(() => engine.pause(), [engine]),
    resume: useCallback(() => engine.resume(), [engine]),
    stop: useCallback(() => engine.cancel(), [engine]),
    updateOptions,
    resetOptions: useCallback(() => setOptions(DEFAULT_SPEECH_OPTIONS), [setOptions]),
  };
}

export type SpeechController = ReturnType<typeof useSpeech>;
