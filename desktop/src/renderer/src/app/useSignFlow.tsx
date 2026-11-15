import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppInfo } from '@shared/ipc';
import { DEFAULT_CONNECTION, isConnectionSettings, type ConnectionSettings } from '../adapters/connection';
import { newId } from '../adapters/emitter';
import { BackendError, createBackendClient, type BackendClient } from '../adapters/remote/backendClient';
import { CloudSpeechEngine, FallbackSpeechEngine } from '../adapters/remote/cloudSpeech';
import { RemoteTranslator } from '../adapters/remote/remoteTranslator';
import type { Adapters, SpeechEngine, Translator } from '../adapters/types';
import { useBackendHealth } from '../hooks/useBackendHealth';
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
  /** Backend client for live mode (tests inject one with a fake fetch). */
  backendClient?: BackendClient;
  /** E2E runs: the cloud voice plays muted. */
  silentSpeech?: boolean;
}

/** A transient, non-blocking message (e.g. "cloud voice unavailable, used the system voice"). */
export interface Notice {
  id: string;
  message: string;
}

/**
 * Everything the screens need: camera, recognition session, speech, notes,
 * captions, and persisted preferences, wired together once.
 */
export function useSignFlowController({ adapters, initialSettings, backendClient, silentSpeech = false }: SignFlowOptions) {
  const [mirrored, setMirrored] = usePersistentState('signflow.mirror', true, isBoolean);
  const [captureToNotes, setCaptureToNotes] = usePersistentState('signflow.captureNotes', legacyCaptureDefault, isBoolean);
  const [savedSettings, setSavedSettings] = usePersistentState<SessionSettings>(
    'signflow.session',
    DEFAULT_SETTINGS,
    isSessionSettings,
  );
  const [connection, setConnection] = usePersistentState<ConnectionSettings>(
    'signflow.connection',
    DEFAULT_CONNECTION,
    isConnectionSettings,
  );
  const [client] = useState<BackendClient>(() => backendClient ?? createBackendClient());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [feedback, setFeedback] = useState<ConfirmFeedback | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const samplerRef = useRef<HTMLVideoElement>(null);
  /** The draft editor, wherever it is rendered (Live stage or dock). */
  const draftTextRef = useRef<HTMLTextAreaElement>(null);

  const camera = useCamera();
  const cameraOn = camera.status === 'on';
  // Live mode swaps the translator (and optionally speech) for the backend's. The
  // recognizer is the same object in both modes, so switching never restarts it.
  const live = connection.mode === 'live';
  const translator = useMemo<Translator>(
    () => (live ? new RemoteTranslator(client, connection.context) : adapters.translator),
    [adapters.translator, client, connection.context, live],
  );
  const speechEngine = useMemo<SpeechEngine>(() => {
    if (!live || connection.voice !== 'cloud') return adapters.speech;
    const cloud = new CloudSpeechEngine({ client, muted: silentSpeech });
    return new FallbackSpeechEngine(cloud, adapters.speech, (err) => {
      const reason = err instanceof BackendError ? err.message : 'playback failed';
      setNotice({ id: newId(), message: `Cloud voice unavailable: ${reason} Used the system voice instead.` });
    });
  }, [adapters.speech, client, connection.voice, live, silentSpeech]);

  const speech = useSpeech(speechEngine);
  const health = useBackendHealth(client, live);
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

  const session = useSignSession({ recognizer: adapters.recognizer, translator }, {
    active: cameraOn,
    initialSettings: { ...savedSettings, ...initialSettings },
    onConfirm: handleConfirm,
  });
  useFrameSampler(samplerRef, adapters.recognizer, cameraOn);
  const captions = useCaptions(session.state);

  const { updateSettings: updateSessionSettings, confirm, discardDraft, clearTranslationError } = session;
  /** Update + persist recognition/speech settings. */
  const updateSettings = useCallback(
    (patch: Partial<SessionSettings>) => {
      updateSessionSettings(patch);
      setSavedSettings((prev) => ({ ...prev, ...patch }));
    },
    [setSavedSettings, updateSessionSettings],
  );

  const updateConnection = useCallback(
    (patch: Partial<ConnectionSettings>) => setConnection((prev) => ({ ...prev, ...patch })),
    [setConnection],
  );
  /** After a live-mode failure: switch to demo and translate the same signs there. */
  const switchToDemo = useCallback(() => {
    setConnection((prev) => ({ ...prev, mode: 'demo' }));
    clearTranslationError();
  }, [clearTranslationError, setConnection]);

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
    translator,
    connection,
    updateConnection,
    switchToDemo,
    live,
    backend: { client, health },
    notice,
    clearNotice: useCallback(() => setNotice(null), []),
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
