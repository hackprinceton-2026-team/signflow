import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { AdapterStatus, Adapters, RecognizedSign } from '../adapters/types';
import {
  initialSessionState,
  sessionReducer,
  type SessionSettings,
  type SessionState,
  type Utterance,
} from '../state/session';

/** What the user asked for when confirming: plain confirm, or confirm and speak. */
export interface ConfirmIntent {
  speak?: boolean;
}

export interface SignSessionOptions {
  /** Recognition runs only while this is true (e.g. the camera is on). */
  active: boolean;
  initialSettings?: Partial<SessionSettings>;
  /**
   * Called once per confirmed sentence (TTS, captions, notes…). Speech must only
   * ever happen here, i.e. for text the user explicitly confirmed.
   */
  onConfirm?: (utterance: Utterance, settings: SessionSettings, intent: ConfirmIntent) => void;
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
  /** The one translation in flight, if any, and the signs it took from the buffer. */
  const inflightRef = useRef<{ ctrl: AbortController; signs: RecognizedSign[] } | null>(null);

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
  useEffect(() => () => inflightRef.current?.ctrl.abort(), []);

  // The translator changed (Demo ↔ Live, or a new translation context): the answer
  // to a request made with the old one is stale. Abort it, give its signs back so
  // the new translator drafts them, and drop an error that came from the old one.
  const translatorRef = useRef(translator);
  useEffect(() => {
    if (translatorRef.current === translator) return;
    translatorRef.current = translator;
    const inflight = inflightRef.current;
    if (inflight) {
      inflightRef.current = null;
      inflight.ctrl.abort();
      dispatch({ type: 'translation/cancelled', signs: inflight.signs });
    }
    dispatch({ type: 'translation/errorCleared' });
  }, [translator]);

  const translate = useCallback(
    async (signs: RecognizedSign[]) => {
      if (signs.length === 0) return;
      const ctrl = new AbortController();
      const request = { ctrl, signs };
      inflightRef.current = request;
      // Only the current request may change state; a late answer to an abandoned
      // one is ignored even if the translator doesn't honor the abort signal.
      const current = () => inflightRef.current === request && !ctrl.signal.aborted;
      dispatch({ type: 'translation/started', signIds: signs.map((s) => s.id) });
      try {
        const draft = await translator.translate(signs, { signal: ctrl.signal });
        if (current()) dispatch({ type: 'translation/succeeded', draft });
      } catch (err) {
        if (!current()) return;
        dispatch({
          type: 'translation/failed',
          error: err instanceof Error ? err.message : 'Translation failed',
          signs,
        });
      } finally {
        if (inflightRef.current === request) inflightRef.current = null;
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

  const confirm = useCallback((intent: ConfirmIntent = {}) => {
    const s = stateRef.current;
    if (!s.draft) return;
    const at = Date.now();
    const next = sessionReducer(s, { type: 'draft/confirmed', at });
    // Update the ref now: a second confirm before React re-renders (double click,
    // shortcut + click) must not confirm, or speak, the same draft twice.
    stateRef.current = next;
    dispatch({ type: 'draft/confirmed', at });
    const added = next.transcript.length > s.transcript.length ? next.transcript.at(-1) : undefined;
    if (added) onConfirmRef.current?.(added, next.settings, intent);
  }, []);

  const editDraft = useCallback((text: string) => dispatch({ type: 'draft/edited', text }), []);
  const discardDraft = useCallback(() => dispatch({ type: 'draft/discarded' }), []);
  const clearBuffer = useCallback(() => dispatch({ type: 'buffer/cleared' }), []);
  const clearTranslationError = useCallback(() => dispatch({ type: 'translation/errorCleared' }), []);
  const clearTranscript = useCallback(() => dispatch({ type: 'transcript/cleared' }), []);
  const updateSettings = useCallback(
    (patch: Partial<SessionSettings>) => dispatch({ type: 'settings/updated', settings: patch }),
    [],
  );

  return {
    state,
    recognizerStatus,
    recognizerName: recognizer.name,
    recognizerSimulated: recognizer.simulated === true,
    recognizerTakesVideo: recognizer.frameFormat === 'jpeg',
    translatorName: translator.name,
    translatorSource: translator.source,
    translateNow,
    confirm,
    editDraft,
    discardDraft,
    clearBuffer,
    clearTranslationError,
    clearTranscript,
    updateSettings,
  };
}

export type SignSession = ReturnType<typeof useSignSession>;
