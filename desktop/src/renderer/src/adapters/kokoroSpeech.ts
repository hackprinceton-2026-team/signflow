import { splitForSpeech } from '@shared/audio';
import {
  decodeKokoroError,
  KOKORO_SPEED_RANGE,
  KOKORO_VOICES,
  resolveKokoroVoice,
  type KokoroErrorCode,
  type KokoroSynthesizeResult,
} from '@shared/kokoro';
import type { SignflowApi } from '@shared/api';
import { Emitter, newId } from './emitter';
import { clampSpeechOptions } from './speech';
import type { AudioLike } from './remote/cloudSpeech';
import type { SpeechEngine, SpeechOptions, SpeechState, SpeechVoice, Unsubscribe, VoiceInUse } from './types';

export type KokoroBridge = SignflowApi['kokoro'];

export const KOKORO_ENGINE_LABEL = 'Kokoro (on-device neural)';

/** Kokoro failed for this text; `remainingText` is what still needs speaking (by the fallback voice). */
export class KokoroSpeechError extends Error {
  constructor(
    readonly code: KokoroErrorCode | 'playback_failed' | 'unknown',
    message: string,
    readonly remainingText: string,
  ) {
    super(message);
    this.name = 'KokoroSpeechError';
  }
}

/** One synthesized chunk's timings, for diagnostics and the performance report. */
export interface KokoroChunkTiming {
  index: number;
  chars: number;
  /** speak() → audio bytes received. */
  synthesizedMs: number;
  /** speak() → playback started. */
  startedMs: number;
  /** Model time reported by the engine. */
  modelMs: number;
  audioS: number;
}

export interface KokoroSpeechOptions {
  bridge: KokoroBridge;
  createAudio?: () => AudioLike;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** E2E runs: synthesize for real, play nothing audible. */
  muted?: boolean;
  now?: () => number;
  onTiming?: (timing: KokoroChunkTiming) => void;
}

/**
 * Kokoro-82M through the main process (src/main/kokoro): synthesis happens in a
 * local utility process, playback here through an <audio> element.
 *
 * Text is split into sentences; all are queued at once (the engine runs them in
 * order), and each plays as soon as it is ready and the previous one ended, so
 * speech starts after the first sentence instead of the whole text.
 *
 * Only `speak()`/`play()` produce sound, and the app calls them only with
 * confirmed text or the fixed Test voice phrase. `cancel()` stops playback and
 * drops every queued sentence; results that arrive afterwards are discarded.
 */
export class KokoroSpeechEngine implements SpeechEngine {
  readonly name = 'Kokoro — Local Neural Voice';
  readonly available = true;
  private readonly stateEmitter = new Emitter<SpeechState>();
  private readonly voicesEmitter = new Emitter<SpeechVoice[]>();
  private readonly voiceInUseEmitter = new Emitter<VoiceInUse>();
  private readonly opts: Required<Omit<KokoroSpeechOptions, 'onTiming'>> & Pick<KokoroSpeechOptions, 'onTiming'>;
  private seq = 0;
  private activeIds: string[] = [];
  private audio: AudioLike | null = null;
  private url: string | null = null;
  /** Ends the current chunk's wait (playback ended, failed, or cancelled). */
  private endChunk: ((err?: Error) => void) | null = null;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private busy = false;

  constructor(options: KokoroSpeechOptions) {
    this.opts = {
      bridge: options.bridge,
      createAudio: options.createAudio ?? (() => new Audio()),
      createObjectURL: options.createObjectURL ?? ((b) => URL.createObjectURL(b)),
      revokeObjectURL: options.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u)),
      muted: options.muted ?? false,
      now: options.now ?? (() => performance.now()),
      onTiming: options.onTiming,
    };
  }

  voices(): SpeechVoice[] {
    return KOKORO_VOICES.map((v, i) => ({ id: v.id, name: v.name, lang: 'en-US', isDefault: i === 0 }));
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
    return `${resolveKokoroVoice(options.kokoroVoiceId).name} · ${KOKORO_ENGINE_LABEL}`;
  }

  /** Fire-and-forget (SpeechEngine contract). Use `play()` to observe failures. */
  speak(text: string, options: SpeechOptions): void {
    void this.play(text, options).catch(() => undefined);
  }

  /**
   * Speak and resolve when everything has played, or when cancelled or
   * superseded (silently). Rejects with KokoroSpeechError if synthesis or
   * playback fails while this text is still the current one.
   */
  async play(text: string, options: SpeechOptions): Promise<void> {
    const chunks = splitForSpeech(text);
    if (chunks.length === 0) return;
    this.cancel();
    const seq = ++this.seq;
    const opts = clampSpeechOptions(options);
    const voice = resolveKokoroVoice(opts.kokoroVoiceId);
    const [min, max] = KOKORO_SPEED_RANGE;
    const speed = Math.min(max, Math.max(min, opts.rate));
    const started = this.opts.now();
    const ids = chunks.map(() => newId());
    this.activeIds = ids;
    this.busy = true;
    this.paused = false;
    this.stateEmitter.emit('speaking');

    const requests = chunks.map((chunk, i) =>
      this.opts.bridge.synthesize({ id: ids[i]!, text: chunk, voice: voice.id, speed }).then((r) => ({ r, at: this.opts.now() })),
    );
    // Later chunks may fail after an earlier failure or cancel; never leave those unobserved.
    for (const r of requests) r.catch(() => undefined);

    for (let i = 0; i < chunks.length; i++) {
      let result: KokoroSynthesizeResult;
      let receivedAt: number;
      try {
        ({ r: result, at: receivedAt } = await requests[i]!);
      } catch (err) {
        if (seq !== this.seq) return;
        this.activeIds = this.activeIds.filter((id) => id !== ids[i]);
        const { code, message } = decodeKokoroError(err instanceof Error ? err.message : String(err));
        if (code === 'cancelled') return;
        this.fail(seq);
        throw new KokoroSpeechError(code, message, chunks.slice(i).join(' '));
      }
      if (seq !== this.seq) return;
      // Only still-outstanding requests are worth cancelling later.
      this.activeIds = this.activeIds.filter((id) => id !== ids[i]);
      if (this.paused) await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
      if (seq !== this.seq) return;
      try {
        await this.playChunk(result, opts.volume, () => {
          const startedMs = Math.round(this.opts.now() - started);
          this.opts.onTiming?.({
            index: i,
            chars: chunks[i]!.length,
            synthesizedMs: Math.round(receivedAt - started),
            startedMs,
            modelMs: result.synthMs,
            audioS: result.durationS,
          });
          if (i === 0 && seq === this.seq) {
            this.voiceInUseEmitter.emit({ source: 'kokoro', id: voice.id, name: voice.name, engine: 'kokoro', fallback: false });
          }
        });
      } catch (err) {
        if (seq !== this.seq) return;
        this.fail(seq);
        const message = err instanceof Error && err.message ? err.message : 'Audio playback failed.';
        throw new KokoroSpeechError('playback_failed', `Couldn't play audio: ${message}`, chunks.slice(i).join(' '));
      }
      if (seq !== this.seq) return;
    }
    if (seq === this.seq) this.finish();
  }

  private playChunk(result: KokoroSynthesizeResult, volume: number, onStart: () => void): Promise<void> {
    this.releaseAudio();
    const url = this.opts.createObjectURL(new Blob([result.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
    this.url = url;
    const audio = this.opts.createAudio();
    audio.src = url;
    audio.volume = volume;
    audio.muted = this.opts.muted;
    // Speed is applied by the model itself, which keeps the voice natural.
    audio.playbackRate = 1;
    this.audio = audio;
    return new Promise<void>((resolve, reject) => {
      this.endChunk = (err) => {
        this.endChunk = null;
        if (err) reject(err);
        else resolve();
      };
      audio.onended = () => {
        // Release first, so a pause before the next chunk can't replay this one.
        this.releaseAudio();
        this.endChunk?.();
      };
      audio.onerror = () => this.endChunk?.(new Error('The audio device could not play this clip.'));
      audio.play().then(onStart, (err: unknown) => this.endChunk?.(err instanceof Error ? err : new Error(String(err))));
    });
  }

  private releaseAudio(): void {
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

  private fail(seq: number): void {
    if (seq !== this.seq) return;
    const ids = this.activeIds;
    this.activeIds = [];
    if (ids.length) void this.opts.bridge.cancel(ids).catch(() => undefined);
    this.finish();
  }

  private finish(): void {
    this.releaseAudio();
    this.activeIds = [];
    this.paused = false;
    this.flushResumeWaiters();
    if (this.busy) {
      this.busy = false;
      this.stateEmitter.emit('idle');
    }
  }

  private flushResumeWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
  }

  pause(): void {
    if (!this.busy || this.paused) return;
    this.paused = true;
    this.audio?.pause();
    this.stateEmitter.emit('paused');
  }

  resume(): void {
    if (!this.busy || !this.paused) return;
    this.paused = false;
    if (this.audio) void this.audio.play().catch(() => this.endChunk?.(new Error('Playback could not resume.')));
    this.flushResumeWaiters();
    this.stateEmitter.emit('speaking');
  }

  cancel(): void {
    this.seq++;
    const ids = this.activeIds;
    this.activeIds = [];
    if (ids.length) void this.opts.bridge.cancel(ids).catch(() => undefined);
    const end = this.endChunk;
    this.endChunk = null;
    this.finish();
    end?.();
  }
}
