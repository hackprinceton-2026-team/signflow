import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppInfo } from '@shared/ipc';
import { DEFAULT_CONNECTION, isConnectionSettings, type ConnectionSettings } from '../adapters/connection';
import { newId } from '../adapters/emitter';
import { BackendError, createBackendClient, type BackendClient } from '../adapters/remote/backendClient';
import { CloudSpeechEngine, FallbackSpeechEngine } from '../adapters/remote/cloudSpeech';
import { KokoroSpeechEngine, KokoroSpeechError, type KokoroBridge } from '../adapters/kokoroSpeech';
import { AslRecognizer, type RecognizerBridge } from '../adapters/external/aslRecognizer';
import { RemoteTranslator } from '../adapters/remote/remoteTranslator';
import type { Adapters, RecognizedSign, SignRecognizer, SpeechEngine, Translator } from '../adapters/types';
import { useBackendHealth } from '../hooks/useBackendHealth';
import { useCamera } from '../hooks/useCamera';
import { useCaptions } from '../hooks/useCaptions';
import { useFrameSampler } from '../hooks/useFrameSampler';
import { useKokoro } from '../hooks/useKokoro';
import { useRecognizerPreview } from '../hooks/useRecognizerPreview';
import { useNotes } from '../hooks/useNotes';
import { usePersistentState } from '../hooks/usePersistentState';
import { useSignSession, type ConfirmIntent } from '../hooks/useSignSession';
import { useSpeech } from '../hooks/useSpeech';
import { useSentenceComposer, useSpeechQueue, type SentenceItem, type SpokenRecord } from '../hooks/useRealtime';
import { DEFAULT_COMM_MODE, glossToWords, isCommMode, type CommMode } from '../state/realtime';
import { DEFAULT_SETTINGS, isSessionSettings, type SessionSettings, type Utterance } from '../state/session';

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** The on-device speech engine: macOS/system voices, or Kokoro's local neural voice. */
export type DeviceSpeechEngine = 'system' | 'kokoro';
const isDeviceSpeechEngine = (v: unknown): v is DeviceSpeechEngine => v === 'system' || v === 'kokoro';

/**
 * Where signs come from: the scripted demo recognizer (default, always works),
 * or the local ASL model (Umar's live.py, a separate process that owns the
 * camera). The 116-sign keyword model is opt-in.
 */
export interface RecognizerSettings {
  source: 'demo' | 'asl';
  allowKeyword: boolean;
}
export const DEFAULT_RECOGNIZER_SETTINGS: RecognizerSettings = { source: 'demo', allowKeyword: false };
export function isRecognizerSettings(v: unknown): v is RecognizerSettings {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (o['source'] === 'demo' || o['source'] === 'asl') && typeof o['allowKeyword'] === 'boolean';
}

function kokoroFailureMessage(err: unknown): string {
  if (err instanceof KokoroSpeechError && err.code === 'missing') return "Kokoro voice isn't installed.";
  if (err instanceof KokoroSpeechError && err.code === 'playback_failed') return "Kokoro voice couldn't play audio.";
  if (err instanceof KokoroSpeechError && err.code === 'timeout') return 'Kokoro voice took too long.';
  return 'Kokoro voice is unavailable.';
}

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
  const [deviceEngine, setDeviceEngine] = usePersistentState<DeviceSpeechEngine>('signflow.speechEngine', 'system', isDeviceSpeechEngine);
  /** Live screen: Words (instant), Sentence (Gemini), or Review (draft + confirm). */
  const [commMode, setCommMode] = usePersistentState<CommMode>('signflow.commMode', DEFAULT_COMM_MODE, isCommMode);
  const [recognizerSettings, setRecognizerSettings] = usePersistentState<RecognizerSettings>(
    'signflow.recognizer',
    DEFAULT_RECOGNIZER_SETTINGS,
    isRecognizerSettings,
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

  // The recognizer: the demo one from `adapters`, or the local ASL model.
  const recognizerBridge = useMemo<RecognizerBridge | undefined>(() => window.signflow?.recognizer, []);
  const useAsl = recognizerSettings.source === 'asl' && recognizerBridge !== undefined;
  const recognizer = useMemo<SignRecognizer>(
    () => (useAsl && recognizerBridge ? new AslRecognizer(recognizerBridge, { allowKeyword: recognizerSettings.allowKeyword }) : adapters.recognizer),
    [adapters.recognizer, recognizerBridge, recognizerSettings.allowKeyword, useAsl],
  );
  /** The recognizer captures the camera itself: the app must not open it too. */
  const externalCamera = recognizer.ownsCamera === true;
  // Recognition with an external recognizer is "on" for that recognizer instance
  // only: switching recognizers (or the keyword opt-in) always turns it off.
  const [externalOnFor, setExternalOnFor] = useState<SignRecognizer | null>(null);
  // Choosing a recognizer that owns the camera: release ours first (one capture session).
  const { stop: stopCamera } = camera;
  useEffect(() => {
    if (externalCamera && camera.status !== 'off') stopCamera();
  }, [camera.status, externalCamera, stopCamera]);
  const recognitionOn = externalCamera ? externalOnFor === recognizer : cameraOn;
  const recognizerPreview = useRecognizerPreview(recognizerBridge, externalCamera && recognitionOn);
  const recognition = useMemo(
    () => ({
      on: recognitionOn,
      /** Signs come from a separate recognizer process that owns the camera. */
      external: externalCamera,
      start: externalCamera ? async () => setExternalOnFor(recognizer) : camera.start,
      stop: externalCamera ? () => setExternalOnFor(null) : camera.stop,
      /** The recognizer's camera preview frames, when its launcher sends them. */
      preview: recognizerPreview,
    }),
    [camera.start, camera.stop, externalCamera, recognitionOn, recognizer, recognizerPreview],
  );
  // Live mode swaps the translator (and optionally speech) for the backend's. The
  // recognizer is the same object in both modes, so switching never restarts it.
  const live = connection.mode === 'live';
  // Sentence mode always composes with Gemini through the backend, whatever Demo/Live says.
  const sentenceMode = commMode === 'sentence';
  const health = useBackendHealth(client, live || sentenceMode);
  // A failed request refreshes the status right away, so the top bar never says
  // "AI online" next to an "unreachable" error.
  const { check: recheckBackend } = health;
  const translator = useMemo<Translator>(
    () => (live ? new RemoteTranslator(client, connection.context, () => void recheckBackend()) : adapters.translator),
    [adapters.translator, client, connection.context, live, recheckBackend],
  );
  /** Sentence mode's composer: Gemini through the SignFlow backend. */
  const geminiTranslator = useMemo<Translator>(
    () => new RemoteTranslator(client, connection.context, () => void recheckBackend()),
    [client, connection.context, recheckBackend],
  );
  const kokoroBridge = useMemo<KokoroBridge | undefined>(() => window.signflow?.kokoro, []);
  const kokoroSelected = deviceEngine === 'kokoro' && kokoroBridge !== undefined;
  const kokoro = useKokoro(kokoroBridge, kokoroSelected);
  // The on-device voice: Kokoro (with the system voice behind it) or the system voice.
  const deviceSpeech = useMemo<SpeechEngine>(() => {
    if (!kokoroSelected || !kokoroBridge) return adapters.speech;
    const engine = new KokoroSpeechEngine({
      bridge: kokoroBridge,
      muted: silentSpeech,
      onTiming: (t) =>
        console.info(
          `[kokoro] sentence ${t.index + 1}: ${t.chars} chars, model ${t.modelMs} ms, audio ready +${t.synthesizedMs} ms, playing +${t.startedMs} ms, ${t.audioS.toFixed(2)} s of audio`,
        ),
    });
    return new FallbackSpeechEngine(engine, adapters.speech, (err) => {
      setNotice({ id: newId(), message: `${kokoroFailureMessage(err)} Used the system voice instead.` });
    });
  }, [adapters.speech, kokoroBridge, kokoroSelected, silentSpeech]);
  const speechEngine = useMemo<SpeechEngine>(() => {
    if (!live || connection.voice !== 'cloud') return deviceSpeech;
    const cloud = new CloudSpeechEngine({ client, muted: silentSpeech });
    const fallbackName = kokoroSelected ? 'the Kokoro voice' : 'the system voice';
    return new FallbackSpeechEngine(cloud, deviceSpeech, (err) => {
      const reason = err instanceof BackendError ? err.message : 'playback failed.';
      setNotice({ id: newId(), message: `Cloud voice unavailable: ${reason} Used ${fallbackName} instead.` });
      if (err instanceof BackendError) void recheckBackend();
    });
  }, [client, connection.voice, deviceSpeech, kokoroSelected, live, recheckBackend, silentSpeech]);

  const speech = useSpeech(speechEngine);
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

  // ---------- Words / Sentence modes: spoken automatically, no confirmation ----------
  /** Glosses behind each queued item, for the transcript. */
  const spokenMetaRef = useRef(new Map<string, { glosses: string[]; confidence: number }>());
  const addUtteranceRef = useRef<(u: Utterance) => void>(() => undefined);
  const onSpeechStart = useCallback(
    (item: SpokenRecord) => {
      const metas = item.ids.map((id) => spokenMetaRef.current.get(id)).filter(Boolean) as { glosses: string[]; confidence: number }[];
      const at = Date.now();
      const text = item.kind === 'sentence' ? item.text : item.text.charAt(0).toUpperCase() + item.text.slice(1);
      addUtteranceRef.current({
        id: `${item.id}-${at}`,
        text,
        glosses: metas.flatMap((m) => m.glosses),
        confidence: metas.length ? metas.reduce((a, m) => a + m.confidence, 0) / metas.length : 1,
        confirmedAt: at,
        edited: false,
      });
      if (captureToNotes) appendToNotes(text, at);
    },
    [appendToNotes, captureToNotes],
  );
  const speechQueue = useSpeechQueue({
    engine: speechEngine,
    speak,
    stopSpeech: speech.stop,
    available: speechAvailable,
    onStart: onSpeechStart,
  });
  const { enqueue } = speechQueue;
  const onWords = useCallback(
    (signs: RecognizedSign[]) => {
      const now = Date.now();
      enqueue(
        signs.map((s) => {
          spokenMetaRef.current.set(s.id, { glosses: [s.gloss], confidence: s.confidence });
          // The recognizer's own "sign ended" time when plausible, else when it arrived.
          const t0 = s.ts <= now && s.ts > now - 10_000 ? s.ts : now;
          return { id: s.id, text: glossToWords(s.gloss), kind: 'word' as const, t0 };
        }),
      );
    },
    [enqueue],
  );
  const deliverSentence = useCallback(
    (item: SentenceItem, text: string) => {
      spokenMetaRef.current.set(item.id, { glosses: item.glosses, confidence: item.confidence });
      enqueue([{ id: item.id, text, kind: 'sentence', t0: item.endedAt }]);
    },
    [enqueue],
  );
  const composer = useSentenceComposer({
    translator: geminiTranslator,
    deliver: deliverSentence,
    onGeminiError: (err) => {
      if (err instanceof BackendError) void recheckBackend();
    },
  });
  const takeBufferRef = useRef<() => RecognizedSign[]>(() => []);
  const { submit: submitSentence } = composer;
  const onSentenceReady = useCallback(() => submitSentence(takeBufferRef.current()), [submitSentence]);

  const session = useSignSession({ recognizer, translator }, {
    active: recognitionOn,
    initialSettings: { ...savedSettings, ...initialSettings },
    onConfirm: handleConfirm,
    mode: commMode,
    onWords,
    onSentenceReady,
  });
  useLayoutEffect(() => {
    addUtteranceRef.current = session.addUtterance;
    takeBufferRef.current = session.takeBuffer;
  });
  // Switching modes or restarting recognition abandons a sentence still being composed:
  // a late Gemini answer must never be spoken. Switching modes also stops the voice.
  const { reset: resetComposer } = composer;
  const { stop: stopQueue } = speechQueue;
  useEffect(() => {
    resetComposer();
  }, [commMode, recognitionOn, resetComposer]);
  useEffect(() => stopQueue, [commMode, stopQueue]);
  const realtime = useMemo(
    () => ({
      mode: commMode,
      setMode: setCommMode,
      queue: speechQueue,
      composer,
      /** Stop speaking now, drop everything queued, and abandon the sentence being composed. */
      stop: () => {
        resetComposer();
        stopQueue();
      },
      /** Sentence mode: end the sentence now (instead of waiting for the recognizer). */
      finishSentence: () => submitSentence(session.takeBuffer()),
    }),
    [commMode, composer, resetComposer, session, setCommMode, speechQueue, stopQueue, submitSentence],
  );
  useFrameSampler(samplerRef, recognizer, cameraOn && !externalCamera);
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
    deviceEngine,
    setDeviceEngine,
    realtime,
    recognizer,
    recognition,
    recognizerSettings,
    updateRecognizerSettings: useCallback(
      (patch: Partial<RecognizerSettings>) => setRecognizerSettings((prev) => ({ ...prev, ...patch })),
      [setRecognizerSettings],
    ),
    aslAvailable: recognizerBridge !== undefined,
    kokoro: { ...kokoro, available: kokoroBridge !== undefined },
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
