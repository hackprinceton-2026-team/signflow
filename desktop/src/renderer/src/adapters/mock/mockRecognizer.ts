import { Emitter, newId, seededRandom } from '../emitter';
import type { AdapterStatus, RecognizedSign, SignRecognizer, Unsubscribe, VideoFrameInput } from '../types';

/** Scripted demo phrases (ASL gloss order). Each pairs with a rule in mockTranslator. */
export const DEMO_PHRASES: readonly (readonly string[])[] = [
  ['HELLO', 'NICE', 'MEET', 'YOU'],
  ['HOW', 'YOU'],
  ['I', 'LEARN', 'SIGN'],
  ['WHERE', 'BATHROOM'],
  ['I', 'NEED', 'HELP'],
  ['PLEASE', 'REPEAT'],
  ['I', 'WANT', 'COFFEE'],
  ['THANK-YOU'],
];

/** Signs the "model" sometimes confuses with the real one while refining. */
const CONFUSABLE: Record<string, string> = {
  HELLO: 'HI',
  NICE: 'CLEAN',
  MEET: 'MEETING',
  YOU: 'YOUR',
  HOW: 'WHAT',
  LEARN: 'STUDY',
  SIGN: 'SIGN-NAME',
  WHERE: 'WHAT',
  NEED: 'MUST',
  HELP: 'SUPPORT',
  WANT: 'LIKE',
  COFFEE: 'TEA',
  'THANK-YOU': 'GOOD',
  PLEASE: 'ENJOY',
  REPEAT: 'AGAIN',
};

const NOISE_GLOSSES = ['UM', 'WAIT', 'NOTHING', 'FINISH'];

export interface MockRecognizerOptions {
  phrases?: readonly (readonly string[])[];
  /** Time between consecutive signs within a phrase. */
  signIntervalMs?: number;
  /** Pause between phrases (long enough for the session to cut a draft). */
  phraseGapMs?: number;
  /** Delay between a provisional and a final event for the same sign. */
  refineMs?: number;
  connectDelayMs?: number;
  /** Only emit while frames keep arriving, as a real model would. */
  requireFrames?: boolean;
  /** A frame older than this counts as "no camera". */
  frameStaleMs?: number;
  /** Probability of a low-confidence noise sign before a real one. */
  noiseRate?: number;
  seed?: number;
  now?: () => number;
}

export class MockSignRecognizer implements SignRecognizer {
  readonly name = 'Mock recognizer';
  readonly frameFormat = 'none' as const;

  private readonly signs = new Emitter<RecognizedSign>();
  private readonly status = new Emitter<AdapterStatus>();
  private readonly opts: Required<Omit<MockRecognizerOptions, 'seed'>>;
  private readonly rand: () => number;

  private timers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private lastFrameAt = -Infinity;
  private phraseIndex = 0;
  private signIndex = 0;

  constructor(options: MockRecognizerOptions = {}) {
    this.opts = {
      phrases: options.phrases ?? DEMO_PHRASES,
      signIntervalMs: options.signIntervalMs ?? 1100,
      phraseGapMs: options.phraseGapMs ?? 2800,
      refineMs: options.refineMs ?? 350,
      connectDelayMs: options.connectDelayMs ?? 400,
      requireFrames: options.requireFrames ?? true,
      frameStaleMs: options.frameStaleMs ?? 1000,
      noiseRate: options.noiseRate ?? 0.15,
      now: options.now ?? (() => Date.now()),
    };
    this.rand = seededRandom(options.seed ?? 7);
  }

  onSign(cb: (sign: RecognizedSign) => void): Unsubscribe {
    return this.signs.on(cb);
  }

  onStatus(cb: (status: AdapterStatus) => void): Unsubscribe {
    return this.status.on(cb);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status.emit({ state: 'connecting', message: 'Loading mock model…' });
    await new Promise<void>((resolve) => this.schedule(resolve, this.opts.connectDelayMs));
    if (!this.running) return;
    this.status.emit({ state: 'ready', message: 'Mock model ready' });
    this.schedule(() => this.tick(), this.opts.signIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.status.emit({ state: 'idle' });
  }

  pushFrame(frame: VideoFrameInput): void {
    this.lastFrameAt = frame.ts;
  }

  private hasFreshFrames(): boolean {
    if (!this.opts.requireFrames) return true;
    return this.opts.now() - this.lastFrameAt <= this.opts.frameStaleMs;
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private between(min: number, max: number): number {
    return Math.round((min + this.rand() * (max - min)) * 100) / 100;
  }

  private tick(): void {
    if (!this.running) return;

    // No hands on camera: idle-poll until frames resume.
    if (!this.hasFreshFrames()) {
      this.schedule(() => this.tick(), 250);
      return;
    }

    const phrases = this.opts.phrases;
    const phrase = phrases[this.phraseIndex % phrases.length] ?? [];
    const gloss = phrase[this.signIndex];

    if (gloss === undefined) {
      // Phrase finished: pause, then move to the next one.
      this.phraseIndex = (this.phraseIndex + 1) % Math.max(phrases.length, 1);
      this.signIndex = 0;
      this.schedule(() => this.tick(), this.opts.phraseGapMs);
      return;
    }

    if (this.rand() < this.opts.noiseRate) {
      const noise = NOISE_GLOSSES[Math.floor(this.rand() * NOISE_GLOSSES.length)] ?? 'UM';
      this.signs.emit({
        id: newId(),
        gloss: noise,
        confidence: this.between(0.22, 0.5),
        ts: this.opts.now(),
        final: true,
      });
    }

    this.emitSign(gloss);
    this.signIndex += 1;
    this.schedule(() => this.tick(), this.opts.signIntervalMs);
  }

  private emitSign(gloss: string): void {
    const id = newId();
    const guess = this.rand() < 0.35 ? (CONFUSABLE[gloss] ?? gloss) : gloss;
    this.signs.emit({ id, gloss: guess, confidence: this.between(0.45, 0.75), ts: this.opts.now(), final: false });
    this.schedule(() => {
      if (!this.running) return;
      this.signs.emit({ id, gloss, confidence: this.between(0.78, 0.98), ts: this.opts.now(), final: true });
    }, this.opts.refineMs);
  }
}
