import { Emitter } from '../emitter';
import { clampSpeechOptions } from '../speech';
import type { PlayableSpeechEngine, SpeechEngine, SpeechOptions, SpeechState, SpeechVoice, Unsubscribe, VoiceInUse } from '../types';
import { BackendError, type BackendClient } from './backendClient';
import type { SpeechResponse } from './guards';

/** The parts of HTMLAudioElement we use (injectable for tests). */
export type AudioLike = Pick<
  HTMLAudioElement,
  'src' | 'volume' | 'playbackRate' | 'preservesPitch' | 'muted' | 'onended' | 'onerror' | 'play' | 'pause'
>;

export interface CloudVoice extends SpeechVoice {
  /** Short description for the voice picker. */
  description: string;
}

/** Amazon Polly Generative voices offered in the app (the most human-like Polly engine). */
export const CLOUD_VOICES: readonly CloudVoice[] = [
  { id: 'Ruth', name: 'Ruth', lang: 'en-US', isDefault: true, description: 'Recommended · US English, female' },
  { id: 'Danielle', name: 'Danielle', lang: 'en-US', isDefault: false, description: 'US English, female' },
  { id: 'Matthew', name: 'Matthew', lang: 'en-US', isDefault: false, description: 'US English, male' },
];

export const DEFAULT_CLOUD_VOICE: CloudVoice = CLOUD_VOICES[0]!;

/** The cloud voice to request: the user's pick if it is offered, otherwise Ruth. */
export function resolveCloudVoice(id: string | undefined): CloudVoice {
  return CLOUD_VOICES.find((v) => v.id === id) ?? DEFAULT_CLOUD_VOICE;
}

const ENGINE_LABELS: Record<SpeechResponse['engine'], string> = {
  generative: 'Amazon Polly Generative',
  'long-form': 'Amazon Polly Long-form',
  neural: 'Amazon Polly Neural',
  standard: 'Amazon Polly Standard',
};

export function cloudEngineLabel(engine: string | undefined): string {
  return (engine && ENGINE_LABELS[engine as SpeechResponse['engine']]) || 'Amazon Polly';
}

/**
 * Confirmed sentences are short; if the cloud voice hasn't answered by then, the
 * system voice speaks instead of leaving the user waiting.
 */
export const CLOUD_SPEAK_TIMEOUT_MS = 10_000;

export interface CloudSpeechOptions {
  client: BackendClient;
  createAudio?: () => AudioLike;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** E2E runs: play nothing audible. */
  muted?: boolean;
}

function base64ToBlob(base64: string, type: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Speech from the SignFlow backend (`POST /speak`, Amazon Polly).
 * It only ever receives text the user confirmed: the app calls `speak()` from
 * the confirm path, never with a draft.
 */
export class CloudSpeechEngine implements PlayableSpeechEngine {
  readonly name = 'SignFlow cloud voice';
  readonly available = true;
  private readonly stateEmitter = new Emitter<SpeechState>();
  private readonly voicesEmitter = new Emitter<SpeechVoice[]>();
  private readonly voiceInUseEmitter = new Emitter<VoiceInUse>();
  private readonly opts: Required<Omit<CloudSpeechOptions, 'muted'>> & { muted: boolean };
  private audio: AudioLike | null = null;
  private url: string | null = null;
  private ctrl: AbortController | null = null;
  private seq = 0;

  constructor(options: CloudSpeechOptions) {
    this.opts = {
      client: options.client,
      createAudio: options.createAudio ?? (() => new Audio()),
      createObjectURL: options.createObjectURL ?? ((b) => URL.createObjectURL(b)),
      revokeObjectURL: options.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u)),
      muted: options.muted ?? false,
    };
  }

  voices(): SpeechVoice[] {
    return [...CLOUD_VOICES];
  }

  onVoicesChanged(cb: (voices: SpeechVoice[]) => void): Unsubscribe {
    return this.voicesEmitter.on(cb);
  }

  onState(cb: (state: SpeechState) => void): Unsubscribe {
    return this.stateEmitter.on(cb);
  }

  onVoiceInUse(cb: (voice: VoiceInUse) => void): Unsubscribe {
    return this.voiceInUseEmitter.on(cb);
  }

  describeVoice(options: SpeechOptions): string {
    return `${resolveCloudVoice(options.cloudVoiceId).name} · ${cloudEngineLabel('generative')}`;
  }

  /** Fire-and-forget (SpeechEngine contract). Use `play()` to observe failures. */
  speak(text: string, options: SpeechOptions): void {
    void this.play(text, options).catch(() => undefined);
  }

  /** Speak and resolve when playback starts; rejects on backend or playback errors. */
  async play(text: string, options: SpeechOptions): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.cancel();
    const seq = ++this.seq;
    const opts = clampSpeechOptions(options);
    const voice = resolveCloudVoice(opts.cloudVoiceId);
    this.ctrl = new AbortController();
    this.stateEmitter.emit('speaking');
    try {
      const res = await this.opts.client.speak(
        { text: trimmed, voice_id: voice.id },
        { signal: this.ctrl.signal, timeoutMs: CLOUD_SPEAK_TIMEOUT_MS },
      );
      if (seq !== this.seq) return; // superseded or cancelled
      this.url = this.opts.createObjectURL(base64ToBlob(res.audio_base64, 'audio/mpeg'));
      const audio = this.opts.createAudio();
      audio.src = this.url;
      audio.volume = opts.volume;
      audio.playbackRate = Math.min(2, Math.max(0.5, opts.rate));
      // Faster or slower playback keeps the voice's natural pitch.
      audio.preservesPitch = true;
      audio.muted = this.opts.muted;
      audio.onended = () => this.finish(seq);
      audio.onerror = () => this.finish(seq);
      this.audio = audio;
      await audio.play();
      if (seq === this.seq) {
        this.voiceInUseEmitter.emit({ source: 'cloud', id: res.voice_id, name: res.voice_id, engine: res.engine, fallback: false });
      }
    } catch (err) {
      if (seq === this.seq) this.finish(seq);
      if (err instanceof BackendError && err.kind === 'aborted') return;
      throw err;
    }
  }

  private finish(seq: number): void {
    if (seq !== this.seq) return;
    this.release();
    this.stateEmitter.emit('idle');
  }

  private release(): void {
    this.ctrl?.abort();
    this.ctrl = null;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    if (this.url) {
      this.opts.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  pause(): void {
    if (!this.audio) return;
    this.audio.pause();
    this.stateEmitter.emit('paused');
  }

  resume(): void {
    if (!this.audio) return;
    void this.audio.play().catch(() => undefined);
    this.stateEmitter.emit('speaking');
  }

  cancel(): void {
    const wasActive = this.ctrl !== null || this.audio !== null;
    this.seq++;
    this.release();
    if (wasActive) this.stateEmitter.emit('idle');
  }
}

/** The text a failed engine still owes, if it reports one (Kokoro fails mid-way per sentence). */
function remainingTextOf(err: unknown, text: string): string {
  const rest = (err as { remainingText?: unknown } | null)?.remainingText;
  return typeof rest === 'string' && rest.trim() ? rest : text;
}

/**
 * Preferred voice first (cloud or Kokoro); if it fails (offline, not
 * configured, model missing, timeout, playback error) the same confirmed text,
 * or the part not yet spoken, is spoken with the fallback voice, and
 * `onFallback` is told. Voice listings are the fallback's (system voices), so
 * the fallback voice can be chosen. A failure that arrives after cancel() or a
 * newer speak() is ignored: stale text is never spoken.
 */
export class FallbackSpeechEngine implements PlayableSpeechEngine {
  readonly available = true;
  /** Whether the fallback voice is currently standing in for the primary. */
  private usingFallback = false;
  /** Identifies the current speak(); bumped by speak() and cancel(). */
  private token = 0;

  constructor(
    private readonly primary: PlayableSpeechEngine,
    private readonly fallback: SpeechEngine,
    private readonly onFallback?: (error: unknown) => void,
  ) {}

  get name(): string {
    return this.primary.name;
  }

  voices(): SpeechVoice[] {
    return this.fallback.voices();
  }

  onVoicesChanged(cb: (voices: SpeechVoice[]) => void): Unsubscribe {
    return this.fallback.onVoicesChanged(cb);
  }

  /** Subscribes to both engines; the returned function removes both listeners. */
  onState(cb: (state: SpeechState) => void): Unsubscribe {
    const offPrimary = this.primary.onState(cb);
    const offFallback = this.fallback.onState(cb);
    return () => {
      offPrimary();
      offFallback();
    };
  }

  onVoiceInUse(cb: (voice: VoiceInUse) => void): Unsubscribe {
    const offPrimary = this.primary.onVoiceInUse?.(cb) ?? (() => undefined);
    const offFallback =
      this.fallback.onVoiceInUse?.((v) => cb({ ...v, fallback: v.fallback || this.usingFallback })) ?? (() => undefined);
    return () => {
      offPrimary();
      offFallback();
    };
  }

  describeVoice(options: SpeechOptions): string | undefined {
    return this.primary.describeVoice?.(options);
  }

  speak(text: string, options: SpeechOptions): void {
    void this.play(text, options).catch(() => undefined);
  }

  /** Resolves once the primary or the fallback has taken the text; never rejects for a fallback-able failure. */
  async play(text: string, options: SpeechOptions): Promise<void> {
    const token = ++this.token;
    this.fallback.cancel();
    this.usingFallback = false;
    try {
      await this.primary.play(text, options);
    } catch (err) {
      if (token !== this.token) return; // cancelled or superseded: speak nothing
      this.onFallback?.(err);
      if (!this.fallback.available) return;
      this.usingFallback = true;
      this.fallback.speak(remainingTextOf(err, text), options);
    }
  }

  pause(): void {
    this.primary.pause();
    this.fallback.pause();
  }

  resume(): void {
    this.primary.resume();
    this.fallback.resume();
  }

  cancel(): void {
    this.token++;
    this.primary.cancel();
    this.fallback.cancel();
  }
}
