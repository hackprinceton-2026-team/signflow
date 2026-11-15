import type { SignflowApi } from '@shared/api';
import type { RecognizerModel, RecognizerStatus } from '@shared/recognizer';
import { Emitter } from '../emitter';
import type { AdapterStatus, RecognizedSign, SignRecognizer, Unsubscribe, VideoFrameInput } from '../types';

export type RecognizerBridge = SignflowApi['recognizer'];

export const MODEL_LABELS: Record<RecognizerModel, string> = {
  demo14: '14-sign model',
  keyword116: '116-sign keyword model',
};

/**
 * Umar's live ASL recognizer (`ml` live.py), reached through the Electron main
 * process (window.signflow.recognizer). The recognizer process owns the camera
 * and does all the vision work; this adapter only turns its validated events
 * into `RecognizedSign`s and sentence ends.
 */
export class AslRecognizer implements SignRecognizer {
  readonly name = 'SignFlow ASL model';
  readonly frameFormat = 'none' as const;
  readonly ownsCamera = true;
  private readonly signs = new Emitter<RecognizedSign>();
  private readonly status = new Emitter<AdapterStatus>();
  private readonly sentenceEnds = new Emitter<void>();
  private readonly seen = new Set<string>();
  private offEvent: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private running = false;
  private lastStatus: AdapterStatus | null = null;

  constructor(
    private readonly bridge: RecognizerBridge,
    private readonly opts: { allowKeyword: boolean },
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.seen.clear();
    this.offEvent = this.bridge.onEvent((event) => {
      if (!this.running) return;
      if (event.type === 'sentence-end') {
        this.sentenceEnds.emit();
        return;
      }
      const { sign } = event;
      if (this.seen.has(sign.id)) return; // already delivered once
      this.seen.add(sign.id);
      this.signs.emit({
        id: sign.id,
        gloss: sign.gloss,
        confidence: sign.confidence,
        ts: sign.ts,
        final: true,
        uncertain: sign.uncertain,
        alternatives: sign.alternatives,
      });
    });
    this.offStatus = this.bridge.onStatus((s) => {
      if (this.running) this.setStatus(toAdapterStatus(s));
    });
    this.setStatus({ state: 'connecting', message: 'Connecting to the SignFlow ASL recognizer…' });
    try {
      const s = await this.bridge.start({ allowKeyword: this.opts.allowKeyword });
      if (this.running) this.setStatus(toAdapterStatus(s));
    } catch (err) {
      if (this.running) this.setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Status arrives both as events and as start()'s answer: report each change once. */
  private setStatus(next: AdapterStatus): void {
    const prev = this.lastStatus;
    if (prev && prev.state === next.state && prev.message === next.message) return;
    this.lastStatus = next;
    this.status.emit(next);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.offEvent?.();
    this.offStatus?.();
    this.offEvent = this.offStatus = null;
    void this.bridge.stop().catch(() => undefined);
    this.setStatus({ state: 'idle' });
  }

  /** The recognizer reads the camera itself; nothing to push. */
  pushFrame(_frame: VideoFrameInput): void {}

  onSign(cb: (sign: RecognizedSign) => void): Unsubscribe {
    return this.signs.on(cb);
  }

  onStatus(cb: (status: AdapterStatus) => void): Unsubscribe {
    return this.status.on(cb);
  }

  onSentenceEnd(cb: () => void): Unsubscribe {
    return this.sentenceEnds.on(cb);
  }
}

function toAdapterStatus(s: RecognizerStatus): AdapterStatus {
  if (s.state === 'ready') return { state: 'ready', message: s.model ? MODEL_LABELS[s.model] : undefined };
  return s.message ? { state: s.state, message: s.message } : { state: s.state };
}
