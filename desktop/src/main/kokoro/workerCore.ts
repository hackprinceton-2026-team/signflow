import { encodeWav16, trimSilence } from '@shared/audio';
import type { KokoroVoiceId } from '@shared/kokoro';
import type { FromWorker, ToWorker } from './protocol';

/** The part of kokoro-js the worker uses (injectable for tests). */
export interface Tts {
  generate(text: string, opts: { voice: KokoroVoiceId; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

export type LoadTts = (modelRoot: string, modelDirName: string, threads: number) => Promise<Tts>;

type Job = Extract<ToWorker, { type: 'synthesize' }>;

/**
 * The Kokoro utility process's logic, minus Electron: loads the model once,
 * synthesizes one request at a time (ONNX Runtime already uses several threads
 * per request), and drops cancelled requests before they reach the model. A
 * request already inside the model can't be interrupted; its result is dropped.
 */
export class KokoroWorkerCore {
  private tts: Promise<Tts> | null = null;
  private readonly queue: Job[] = [];
  private running: Job | null = null;
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly loadTts: LoadTts,
    private readonly send: (msg: FromWorker) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  handle(msg: ToWorker): void {
    switch (msg.type) {
      case 'load':
        this.load(msg);
        return;
      case 'synthesize':
        this.cancelled.delete(msg.id);
        this.queue.push(msg);
        void this.pump();
        return;
      case 'cancel':
        this.cancel(msg.ids);
        return;
    }
  }

  private load(msg: Extract<ToWorker, { type: 'load' }>): void {
    if (this.tts) return;
    const started = this.now();
    this.tts = this.loadTts(msg.modelRoot, msg.modelDirName, msg.threads);
    this.tts.then(
      () => this.send({ type: 'loaded', loadMs: Math.round(this.now() - started) }),
      (err: unknown) => {
        this.send({ type: 'load-error', message: errorMessage(err) });
        // Everything waiting fails now; a later `load` may try again.
        this.tts = null;
        for (const job of this.queue.splice(0)) {
          this.send({ type: 'error', id: job.id, code: 'load_failed', message: errorMessage(err) });
        }
      },
    );
    void this.pump();
  }

  private cancel(ids: string[] | 'all'): void {
    const drop = ids === 'all' ? null : new Set(ids);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i]!;
      if (!drop || drop.has(job.id)) {
        this.queue.splice(i, 1);
        this.send({ type: 'error', id: job.id, code: 'cancelled', message: 'Cancelled' });
      }
    }
    if (this.running && (!drop || drop.has(this.running.id))) this.cancelled.add(this.running.id);
  }

  private async pump(): Promise<void> {
    if (this.running || !this.tts) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    let tts: Tts;
    try {
      tts = await this.tts;
    } catch (err) {
      this.cancelled.delete(job.id);
      this.send({ type: 'error', id: job.id, code: 'load_failed', message: errorMessage(err) });
      this.running = null;
      return;
    }
    try {
      const started = this.now();
      const raw = await tts.generate(job.text, { voice: job.voice, speed: job.speed });
      const synthMs = Math.round(this.now() - started);
      if (this.cancelled.delete(job.id)) {
        this.send({ type: 'error', id: job.id, code: 'cancelled', message: 'Cancelled' });
      } else {
        const trimmed = trimSilence(raw.audio, raw.sampling_rate);
        if (trimmed.length === 0) throw new Error('The model produced no audio');
        this.send({
          type: 'result',
          id: job.id,
          wav: encodeWav16(trimmed, raw.sampling_rate),
          durationS: trimmed.length / raw.sampling_rate,
          synthMs,
        });
      }
    } catch (err) {
      this.cancelled.delete(job.id);
      this.send({ type: 'error', id: job.id, code: 'synthesis_failed', message: errorMessage(err) });
    } finally {
      this.running = null;
      void this.pump();
    }
  }
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}
