import { Emitter } from '../emitter';
import { clampSpeechOptions } from '../speech';
import type { SpeechEngine, SpeechOptions, SpeechState, SpeechVoice, Unsubscribe } from '../types';
import { BackendError, type BackendClient } from './backendClient';

/** The parts of HTMLAudioElement we use (injectable for tests). */
export type AudioLike = Pick<HTMLAudioElement, 'src' | 'volume' | 'playbackRate' | 'muted' | 'onended' | 'onerror' | 'play' | 'pause'>;

/** Amazon Polly voices offered in the app; the backend validates and has its own default. */
export const CLOUD_VOICES: SpeechVoice[] = [
  { id: 'Joanna', name: 'Joanna (cloud)', lang: 'en-US', isDefault: true },
  { id: 'Matthew', name: 'Matthew (cloud)', lang: 'en-US', isDefault: false },
];

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
export class CloudSpeechEngine implements SpeechEngine {
  readonly name = 'SignFlow cloud voice';
  readonly available = true;
  private readonly stateEmitter = new Emitter<SpeechState>();
  private readonly voicesEmitter = new Emitter<SpeechVoice[]>();
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
    return CLOUD_VOICES;
  }

  onVoicesChanged(cb: (voices: SpeechVoice[]) => void): Unsubscribe {
    return this.voicesEmitter.on(cb);
  }

  onState(cb: (state: SpeechState) => void): Unsubscribe {
    return this.stateEmitter.on(cb);
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
    const voiceId = CLOUD_VOICES.some((v) => v.id === opts.voiceId) ? opts.voiceId : undefined;
    this.ctrl = new AbortController();
    this.stateEmitter.emit('speaking');
    try {
      const res = await this.opts.client.speak({ text: trimmed, ...(voiceId ? { voice_id: voiceId } : {}) }, { signal: this.ctrl.signal });
      if (seq !== this.seq) return; // superseded or cancelled
      this.url = this.opts.createObjectURL(base64ToBlob(res.audio_base64, 'audio/mpeg'));
      const audio = this.opts.createAudio();
      audio.src = this.url;
      audio.volume = opts.volume;
      audio.playbackRate = Math.min(2, Math.max(0.5, opts.rate));
      audio.muted = this.opts.muted;
      audio.onended = () => this.finish(seq);
      audio.onerror = () => this.finish(seq);
      this.audio = audio;
      await audio.play();
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

/**
 * Cloud voice first; if it fails (offline, not configured, playback error) the
 * same confirmed text is spoken with the system voice, and `onFallback` is told.
 */
export class FallbackSpeechEngine implements SpeechEngine {
  readonly available = true;

  constructor(
    private readonly primary: CloudSpeechEngine,
    private readonly fallback: SpeechEngine,
    private readonly onFallback?: (error: unknown) => void,
  ) {}

  get name(): string {
    return this.primary.name;
  }

  voices(): SpeechVoice[] {
    return this.primary.voices();
  }

  onVoicesChanged(cb: (voices: SpeechVoice[]) => void): Unsubscribe {
    return this.primary.onVoicesChanged(cb);
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

  speak(text: string, options: SpeechOptions): void {
    this.fallback.cancel();
    this.primary.play(text, options).catch((err: unknown) => {
      this.onFallback?.(err);
      // Cloud voice names mean nothing to the system engine; let it pick its default.
      if (this.fallback.available) this.fallback.speak(text, { ...options, voiceId: undefined });
    });
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
    this.primary.cancel();
    this.fallback.cancel();
  }
}
