import { Emitter } from './emitter';
import type { SpeechEngine, SpeechOptions, SpeechState, SpeechVoice, Unsubscribe } from './types';

export function clampSpeechOptions(opts: SpeechOptions): SpeechOptions {
  const clamp = (v: number, min: number, max: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    voiceId: opts.voiceId,
    rate: clamp(opts.rate, 0.1, 10, 1),
    pitch: clamp(opts.pitch, 0, 2, 1),
    volume: clamp(opts.volume, 0, 1, 1),
  };
}

/** Text-to-speech through the browser's Web Speech API (system voices). */
export class WebSpeechEngine implements SpeechEngine {
  readonly name = 'System voices';
  private readonly stateEmitter = new Emitter<SpeechState>();
  private readonly voicesEmitter = new Emitter<SpeechVoice[]>();
  private current: SpeechSynthesisUtterance | null = null;

  constructor(
    private readonly synth: SpeechSynthesis = window.speechSynthesis,
    private readonly Utterance: typeof SpeechSynthesisUtterance = window.SpeechSynthesisUtterance,
  ) {
    this.synth.addEventListener?.('voiceschanged', () => this.voicesEmitter.emit(this.voices()));
  }

  get available(): boolean {
    return Boolean(this.synth && this.Utterance);
  }

  voices(): SpeechVoice[] {
    return this.synth.getVoices().map((v) => ({
      id: v.voiceURI,
      name: v.name,
      lang: v.lang,
      isDefault: v.default,
    }));
  }

  onVoicesChanged(cb: (voices: SpeechVoice[]) => void): Unsubscribe {
    return this.voicesEmitter.on(cb);
  }

  onState(cb: (state: SpeechState) => void): Unsubscribe {
    return this.stateEmitter.on(cb);
  }

  speak(text: string, options: SpeechOptions): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const opts = clampSpeechOptions(options);
    this.synth.cancel();

    const u = new this.Utterance(trimmed);
    const voice = opts.voiceId ? this.synth.getVoices().find((v) => v.voiceURI === opts.voiceId) : undefined;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = opts.rate;
    u.pitch = opts.pitch;
    u.volume = opts.volume;

    const settle = () => {
      if (this.current === u) {
        this.current = null;
        this.stateEmitter.emit('idle');
      }
    };
    u.onstart = () => this.stateEmitter.emit('speaking');
    u.onpause = () => this.stateEmitter.emit('paused');
    u.onresume = () => this.stateEmitter.emit('speaking');
    u.onend = settle;
    u.onerror = settle;

    this.current = u;
    this.synth.speak(u);
  }

  pause(): void {
    if (!this.current) return;
    this.synth.pause();
    this.stateEmitter.emit('paused');
  }

  resume(): void {
    if (!this.current) return;
    this.synth.resume();
    this.stateEmitter.emit('speaking');
  }

  cancel(): void {
    this.current = null;
    this.synth.cancel();
    this.stateEmitter.emit('idle');
  }
}

/** Silent stand-in (tests, or machines without speech synthesis). */
export class MockSpeechEngine implements SpeechEngine {
  readonly name = 'Silent (mock)';
  readonly available = true;
  readonly spoken: { text: string; opts: SpeechOptions }[] = [];
  private readonly stateEmitter = new Emitter<SpeechState>();
  private readonly voicesEmitter = new Emitter<SpeechVoice[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: SpeechState = 'idle';

  constructor(private readonly msPerChar = 45) {}

  voices(): SpeechVoice[] {
    return [{ id: 'mock-voice', name: 'Mock Voice', lang: 'en-US', isDefault: true }];
  }

  onVoicesChanged(cb: (voices: SpeechVoice[]) => void): Unsubscribe {
    return this.voicesEmitter.on(cb);
  }

  onState(cb: (state: SpeechState) => void): Unsubscribe {
    return this.stateEmitter.on(cb);
  }

  private set(state: SpeechState) {
    this.state = state;
    this.stateEmitter.emit(state);
  }

  speak(text: string, opts: SpeechOptions): void {
    if (!text.trim()) return;
    this.cancel();
    this.spoken.push({ text, opts: clampSpeechOptions(opts) });
    this.set('speaking');
    this.timer = setTimeout(() => this.set('idle'), Math.max(200, (text.length * this.msPerChar) / opts.rate));
  }

  pause(): void {
    if (this.state === 'speaking') this.set('paused');
  }

  resume(): void {
    if (this.state === 'paused') this.set('speaking');
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.state !== 'idle') this.set('idle');
  }
}
