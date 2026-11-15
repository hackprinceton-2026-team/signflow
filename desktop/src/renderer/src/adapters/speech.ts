import { Emitter } from './emitter';
import type { SpeechEngine, SpeechOptions, SpeechState, SpeechVoice, Unsubscribe, VoiceInUse } from './types';

export function clampSpeechOptions(opts: SpeechOptions): SpeechOptions {
  const clamp = (v: number, min: number, max: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    voiceId: opts.voiceId,
    cloudVoiceId: opts.cloudVoiceId,
    rate: clamp(opts.rate, 0.1, 10, 1),
    pitch: clamp(opts.pitch, 0, 2, 1),
    volume: clamp(opts.volume, 0, 1, 1),
  };
}

/** Novelty and robotic macOS voices: listed, but never picked automatically. */
const NOVELTY_VOICES = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Eddy', 'Flo', 'Fred', 'Good News', 'Grandma',
  'Grandpa', 'Jester', 'Junior', 'Kathy', 'Organ', 'Ralph', 'Reed', 'Rocko', 'Sandy', 'Shelley', 'Superstar',
  'Trinoids', 'Whisper', 'Wobble', 'Zarvox',
]);
/** Natural-sounding English voices that ship with (or download into) macOS. */
const NATURAL_VOICES = new Set(['Ava', 'Zoe', 'Allison', 'Samantha', 'Susan', 'Tom', 'Evan', 'Nathan', 'Joelle', 'Noelle', 'Nicky', 'Aaron', 'Alex']);

/** "Ava (Premium)" → "Ava"; "Eddy (English (US))" → "Eddy". */
export const baseVoiceName = (name: string): string => name.replace(/\s*\(.*\)\s*$/, '').trim();

function voiceScore(v: SpeechVoice): number {
  const lang = v.lang.replace('_', '-').toLowerCase();
  const base = baseVoiceName(v.name);
  let score = lang === 'en-us' ? 30 : lang.startsWith('en') ? 20 : 0;
  if (/\(premium\)/i.test(v.name)) score += 8;
  else if (/\(enhanced\)/i.test(v.name)) score += 6;
  if (NATURAL_VOICES.has(base)) score += 4;
  if (NOVELTY_VOICES.has(base)) score -= 50;
  if (v.isDefault && score >= 20) score += 2;
  return score;
}

/**
 * The system voice to use: the user's choice if it is installed, otherwise the
 * most natural English voice available (Premium/Enhanced first, novelty voices
 * never). Undefined when the platform lists no voices.
 */
export function pickSystemVoice(voices: readonly SpeechVoice[], preferredId?: string): SpeechVoice | undefined {
  const chosen = preferredId ? voices.find((v) => v.id === preferredId) : undefined;
  if (chosen) return chosen;
  let best: SpeechVoice | undefined;
  let bestScore = -Infinity;
  for (const v of voices) {
    const score = voiceScore(v);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** How long to wait for Chromium to load system voices (macOS lists none at first). */
export const VOICE_LOAD_WAIT_MS = 1000;

/** Text-to-speech through the browser's Web Speech API (system voices). */
export class WebSpeechEngine implements SpeechEngine {
  readonly name = 'System voices';
  private readonly stateEmitter = new Emitter<SpeechState>();
  private readonly voicesEmitter = new Emitter<SpeechVoice[]>();
  private readonly voiceInUseEmitter = new Emitter<VoiceInUse>();
  private current: SpeechSynthesisUtterance | null = null;
  /** Speech waiting for the voice list to load. */
  private pending: { run: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly synth: SpeechSynthesis = window.speechSynthesis,
    private readonly Utterance: typeof SpeechSynthesisUtterance = window.SpeechSynthesisUtterance,
    private readonly voiceLoadWaitMs = VOICE_LOAD_WAIT_MS,
  ) {
    this.synth.addEventListener?.('voiceschanged', () => {
      this.voicesEmitter.emit(this.voices());
      if (this.pending && this.synth.getVoices().length > 0) this.flushPending();
    });
  }

  get available(): boolean {
    return Boolean(this.synth && this.Utterance);
  }

  voices(): SpeechVoice[] {
    return this.synth.getVoices().map(toSpeechVoice);
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

  speak(text: string, options: SpeechOptions): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const opts = clampSpeechOptions(options);
    this.clearPending();
    this.synth.cancel();
    if (this.synth.getVoices().length > 0 || this.voiceLoadWaitMs <= 0) {
      this.utter(trimmed, opts);
      return;
    }
    // Chromium loads voices asynchronously; speaking before they arrive uses a
    // random or non-English voice on macOS. Wait briefly, then speak regardless.
    const run = () => this.utter(trimmed, opts);
    this.pending = { run, timer: setTimeout(() => this.flushPending(), this.voiceLoadWaitMs) };
  }

  private flushPending(): void {
    const pending = this.pending;
    this.clearPending();
    pending?.run();
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private utter(trimmed: string, opts: SpeechOptions): void {
    const u = new this.Utterance(trimmed);
    const all = this.synth.getVoices();
    const picked = pickSystemVoice(all.map(toSpeechVoice), opts.voiceId);
    const voice = picked ? all.find((v) => v.voiceURI === picked.id) : undefined;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = 'en-US';
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
    // A synth left paused (e.g. paused, then cancelled) silently queues new speech.
    if (this.synth.paused) this.synth.resume();
    this.synth.speak(u);
    this.voiceInUseEmitter.emit({ source: 'system', id: voice?.voiceURI ?? '', name: voice?.name ?? 'System default', fallback: false });
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
    this.clearPending();
    this.current = null;
    this.synth.cancel();
    this.stateEmitter.emit('idle');
  }
}

function toSpeechVoice(v: SpeechSynthesisVoice): SpeechVoice {
  return { id: v.voiceURI, name: v.name, lang: v.lang, isDefault: v.default };
}

/** Silent stand-in (tests, or machines without speech synthesis). */
export class MockSpeechEngine implements SpeechEngine {
  readonly name = 'Silent (mock)';
  readonly available: boolean = true;
  readonly spoken: { text: string; opts: SpeechOptions }[] = [];
  private readonly stateEmitter = new Emitter<SpeechState>();
  private readonly voicesEmitter = new Emitter<SpeechVoice[]>();
  private readonly voiceInUseEmitter = new Emitter<VoiceInUse>();
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

  onVoiceInUse(cb: (voice: VoiceInUse) => void): Unsubscribe {
    return this.voiceInUseEmitter.on(cb);
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
    this.voiceInUseEmitter.emit({ source: 'system', id: 'mock-voice', name: 'Mock Voice', fallback: false });
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
