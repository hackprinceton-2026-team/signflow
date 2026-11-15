/**
 * Adapter interfaces between the UI and the ML / backend / speech services.
 *
 * The UI only ever talks to these interfaces. Mock implementations live next
 * to this file; real ones (WebSocket to backend/, see docs/interfaces.md)
 * plug in through `createAdapters()` without touching any component.
 */

export type Unsubscribe = () => void;

/** One recognized sign, as streamed by the ML model. */
export interface RecognizedSign {
  id: string;
  /** Uppercase ASL gloss, e.g. "HELLO", "THANK-YOU". */
  gloss: string;
  /** 0..1 */
  confidence: number;
  /** ms since epoch: when the sign ended. */
  ts: number;
  /** false = provisional; a later event with the same id replaces it. */
  final: boolean;
}

export type AdapterState = 'idle' | 'connecting' | 'ready' | 'error';

export interface AdapterStatus {
  state: AdapterState;
  message?: string;
}

/** A video frame handed to the recognizer. */
export interface VideoFrameInput {
  ts: number;
  width: number;
  height: number;
  /** JPEG bytes. Optional so the mock can run without encoding frames. */
  jpeg?: Blob;
}

export interface SignRecognizer {
  readonly name: string;
  /**
   * True for the demo recognizer: it plays scripted signs (with simulated
   * confidence) while the camera runs, whatever is actually signed.
   */
  readonly simulated?: boolean;
  /** What the frame sampler should send: metadata only, or JPEG-encoded frames. */
  readonly frameFormat: 'none' | 'jpeg';
  start(): Promise<void>;
  stop(): void;
  pushFrame(frame: VideoFrameInput): void;
  onSign(cb: (sign: RecognizedSign) => void): Unsubscribe;
  onStatus(cb: (status: AdapterStatus) => void): Unsubscribe;
}

/** Who wrote a draft: the on-device demo rules, the AI (Gemini via the backend), or both (merged). */
export type DraftSource = 'demo' | 'ai' | 'mixed';

/** English text generated from a run of signs, awaiting user confirmation. */
export interface EnglishDraft {
  id: string;
  text: string;
  signIds: string[];
  glosses: string[];
  /**
   * 0..1: the average *recognition* confidence of the signs in the draft.
   * Neither translator reports a confidence for the English itself.
   */
  confidence: number;
  createdAt: number;
  source: DraftSource;
}

export interface Translator {
  readonly name: string;
  /** What produces the English: on-device demo rules or the AI backend. */
  readonly source: 'demo' | 'ai';
  translate(signs: readonly RecognizedSign[], opts?: { signal?: AbortSignal }): Promise<EnglishDraft>;
}

export interface SpeechVoice {
  id: string;
  name: string;
  lang: string;
  isDefault: boolean;
}

export interface SpeechOptions {
  /** System voice (voiceURI). Undefined = the best available English voice. */
  voiceId?: string | undefined;
  /** Cloud voice (Amazon Polly id, e.g. "Ruth"). Undefined = the app default. */
  cloudVoiceId?: string | undefined;
  /** Kokoro local voice (e.g. "af_heart"). Undefined = the app default. */
  kokoroVoiceId?: string | undefined;
  /** 0.1..10, 1 = normal */
  rate: number;
  /** 0..2, 1 = normal */
  pitch: number;
  /** 0..1 */
  volume: number;
}

export type SpeechState = 'idle' | 'speaking' | 'paused';

/** The voice that actually spoke the most recent text. */
export interface VoiceInUse {
  source: 'cloud' | 'kokoro' | 'system';
  /** Voice id: Polly id for cloud, Kokoro voice id, or voiceURI for system ('' if the platform picked). */
  id: string;
  /** Display name, e.g. "Ruth" or "Samantha". */
  name: string;
  /** Cloud: the Polly engine that produced the audio, e.g. "generative". Kokoro: "kokoro". */
  engine?: string | undefined;
  /** The preferred voice (cloud or Kokoro) was requested but failed, so a fallback voice spoke instead. */
  fallback: boolean;
}

export interface SpeechEngine {
  readonly name: string;
  readonly available: boolean;
  voices(): SpeechVoice[];
  onVoicesChanged(cb: (voices: SpeechVoice[]) => void): Unsubscribe;
  speak(text: string, opts: SpeechOptions): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  onState(cb: (state: SpeechState) => void): Unsubscribe;
  /** Optional: told which voice actually spoke, once per `speak()` that produced sound. */
  onVoiceInUse?(cb: (voice: VoiceInUse) => void): Unsubscribe;
  /** Optional: a label for the voice these options select, e.g. "Heart · Kokoro (on-device neural)". */
  describeVoice?(opts: SpeechOptions): string | undefined;
}

/** A SpeechEngine whose speech can be awaited: rejects if it fails while still current. */
export interface PlayableSpeechEngine extends SpeechEngine {
  play(text: string, opts: SpeechOptions): Promise<void>;
}

export interface Adapters {
  recognizer: SignRecognizer;
  translator: Translator;
  speech: SpeechEngine;
}
