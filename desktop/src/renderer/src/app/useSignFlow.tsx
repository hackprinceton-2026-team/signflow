import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppInfo } from '@shared/ipc';
import type { Adapters } from '../adapters/types';
import { useCamera } from '../hooks/useCamera';
import { useCaptions } from '../hooks/useCaptions';
import { useFrameSampler } from '../hooks/useFrameSampler';
import { useNotes } from '../hooks/useNotes';
import { usePersistentState } from '../hooks/usePersistentState';
import { useSignSession, type ConfirmIntent } from '../hooks/useSignSession';
import { useSpeech } from '../hooks/useSpeech';
import { DEFAULT_SETTINGS, isSessionSettings, type SessionSettings, type Utterance } from '../state/session';

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** Notes capture was a "mode" before the redesign; carry that choice over once. */
function legacyCaptureDefault(): boolean {
  try {
    return localStorage.getItem('signflow.mode') === '"notes"';
  } catch {
    return false;
  }
}

/** Shown briefly after a confirm so the user knows exactly what happened. */
export interface ConfirmFeedback {
  id: string;
  text: string;
  spoken: boolean;
  noted: boolean;
}

export interface SignFlowOptions {
  adapters: Adapters;
  /** Overrides persisted settings (tests). */
  initialSettings?: Partial<SessionSettings>;
}

/**
 * Everything the screens need: camera, recognition session, speech, notes,
 * captions, and persisted preferences, wired together once.
 */
export function useSignFlowController({ adapters, initialSettings }: SignFlowOptions) {
  const [mirrored, setMirrored] = usePersistentState('signflow.mirror', true, isBoolean);
  const [captureToNotes, setCaptureToNotes] = usePersistentState('signflow.captureNotes', legacyCaptureDefault, isBoolean);
  const [savedSettings, setSavedSettings] = usePersistentState<SessionSettings>(
    'signflow.session',
    DEFAULT_SETTINGS,
    isSessionSettings,
  );
  const [feedback, setFeedback] = useState<ConfirmFeedback | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const samplerRef = useRef<HTMLVideoElement>(null);
  /** The draft editor, wherever it is rendered (Live stage or dock). */
  const draftTextRef = useRef<HTMLTextAreaElement>(null);

  const camera = useCamera();
  const cameraOn = camera.status === 'on';
  const speech = useSpeech(adapters.speech);
  const notes = useNotes();

  const { speak, available: speechAvailable } = speech;
  const { append: appendToNotes } = notes;

  // The single place confirmed text fans out. Speech happens only for text the
  // user confirmed, and only when they asked (Speak) or opted in (autoSpeak).
  const handleConfirm = useCallback(
    (utterance: Utterance, settings: SessionSettings, intent: ConfirmIntent) => {
      const spoken = Boolean(intent.speak || settings.autoSpeak) && speechAvailable;
      if (captureToNotes) appendToNotes(utterance.text, utterance.confirmedAt);
      if (spoken) speak(utterance.text);
      setFeedback({ id: utterance.id, text: utterance.text, spoken, noted: captureToNotes });
    },
    [appendToNotes, captureToNotes, speak, speechAvailable],
  );

  const session = useSignSession(adapters, {
    active: cameraOn,
    initialSettings: { ...savedSettings, ...initialSettings },
    onConfirm: handleConfirm,
  });
  useFrameSampler(samplerRef, adapters.recognizer, cameraOn);
  const captions = useCaptions(session.state);

  const { updateSettings: updateSessionSettings, confirm, discardDraft } = session;
  /** Update + persist recognition/speech settings. */
  const updateSettings = useCallback(
    (patch: Partial<SessionSettings>) => {
      updateSessionSettings(patch);
      setSavedSettings((prev) => ({ ...prev, ...patch }));
    },
    [setSavedSettings, updateSessionSettings],
  );

  const confirmDraft = useCallback(() => confirm(), [confirm]);
  const speakDraft = useCallback(() => confirm({ speak: true }), [confirm]);

  useEffect(() => {
    let alive = true;
    window.signflow
      .getAppInfo()
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, []);

  return {
    adapters,
    info,
    camera,
    cameraOn,
    samplerRef,
    draftTextRef,
    session,
    speech,
    notes,
    captions,
    mirrored,
    setMirrored,
    captureToNotes,
    setCaptureToNotes,
    updateSettings,
    confirmDraft,
    speakDraft,
    discardDraft,
    feedback,
    clearFeedback: useCallback(() => setFeedback(null), []),
  };
}

export type SignFlow = ReturnType<typeof useSignFlowController>;

const SignFlowContext = createContext<SignFlow | null>(null);

export function SignFlowProvider({ value, children }: { value: SignFlow; children: ReactNode }) {
  return <SignFlowContext.Provider value={value}>{children}</SignFlowContext.Provider>;
}

export function useSignFlow(): SignFlow {
  const ctx = useContext(SignFlowContext);
  if (!ctx) throw new Error('useSignFlow must be used inside <SignFlowProvider>');
  return ctx;
}
