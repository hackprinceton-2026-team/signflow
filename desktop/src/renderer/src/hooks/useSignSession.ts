import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { AdapterStatus, Adapters, RecognizedSign } from '../adapters/types';
import {
  initialSessionState,
  sessionReducer,
  type SessionSettings,
  type SessionState,
  type Utterance,
} from '../state/session';

export interface SignSessionOptions {
  /** Recognition runs only while this is true (e.g. the camera is on). */
  active: boolean;
  initialSettings?: Partial<SessionSettings>;
  /** Called once per confirmed sentence (TTS, captions, notes…). */
  onConfirm?: (utterance: Utterance, settings: SessionSettings) => void;
}

/**
 * Orchestrates recognizer → buffer → (pause) → translator → draft → confirm.
 * All state transitions live in the pure `sessionReducer`.
 */
export function useSignSession(adapters: Pick<Adapters, 'recognizer' | 'translator'>, options: SignSessionOptions) {
  const { recognizer, translator } = adapters;
  const [state, dispatch] = useReducer(sessionReducer, options.initialSettings, initialSessionState);
  const [recognizerStatus, setRecognizerStatus] = useState<AdapterStatus>({ state: 'idle' });

  // Latest values for stable callbacks (synced after render, never during).
  const stateRef = useRef<SessionState>(state);
  const onConfirmRef = useRef(options.onConfirm);
  useLayoutEffect(() => {
    stateRef.current = state;
    onConfirmRef.current = options.onConfirm;
  });
  const abortRef = useRef<AbortController | null>(null);

  // Recognizer events → reducer.
  useEffect(() => {
    const offSign = recognizer.onSign((sign) => dispatch({ type: 'sign/received', sign }));
    const offStatus = recognizer.onStatus(setRecognizerStatus);
    return () => {
      offSign();
      offStatus();
    };
  }, [recognizer]);

  // Start/stop recognition with `active`.
  useEffect(() => {
    if (!options.active) return;
    recognizer.start().catch((err: unknown) =>
      setRecognizerStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => recognizer.stop();
  }, [options.active, recognizer]);

  // Cancel in-flight translation on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const translate = useCallback(
    async (signs: RecognizedSign[]) => {
      if (signs.length === 0) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      dispatch({ type: 'translation/started', signIds: signs.map((s) => s.id) });
      try {
        const draft = await translator.translate(signs, { signal: ctrl.signal });
        if (!ctrl.signal.aborted) dispatch({ type: 'translation/succeeded', draft });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        dispatch({
          type: 'translation/failed',
          error: err instanceof Error ? err.message : 'Translation failed',
          signs,
        });
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [translator],
  );

  // After `pauseMs` without a new accepted sign, translate what we have.
  const { buffer, draftStatus, settings } = state;
  useEffect(() => {
    if (buffer.length === 0 || draftStatus !== 'idle') return;
    const t = setTimeout(() => void translate(buffer), settings.pauseMs);
    return () => clearTimeout(t);
  }, [buffer, draftStatus, settings.pauseMs, translate]);

  const translateNow = useCallback(() => {
    const s = stateRef.current;
    if (s.draftStatus === 'translating') return;
    void translate(s.buffer);
  }, [translate]);

  const confirm = useCallback(() => {
    const s = stateRef.current;
    if (!s.draft) return;
    const at = Date.now();
    const next = sessionReducer(s, { type: 'draft/confirmed', at });
    dispatch({ type: 'draft/confirmed', at });
    const added = next.transcript.length > s.transcript.length ? next.transcript.at(-1) : undefined;
    if (added) onConfirmRef.current?.(added, next.settings);
  }, []);

  const editDraft = useCallback((text: string) => dispatch({ type: 'draft/edited', text }), []);
  const discardDraft = useCallback(() => dispatch({ type: 'draft/discarded' }), []);
  const clearBuffer = useCallback(() => dispatch({ type: 'buffer/cleared' }), []);
  const clearTranscript = useCallback(() => dispatch({ type: 'transcript/cleared' }), []);
  const updateSettings = useCallback(
    (patch: Partial<SessionSettings>) => dispatch({ type: 'settings/updated', settings: patch }),
    [],
  );

  return {
    state,
    recognizerStatus,
    recognizerName: recognizer.name,
    translatorName: translator.name,
    translateNow,
    confirm,
    editDraft,
    discardDraft,
    clearBuffer,
    clearTranscript,
    updateSettings,
  };
}

export type SignSession = ReturnType<typeof useSignSession>;
