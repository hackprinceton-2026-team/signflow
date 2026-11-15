import {
  encodeKokoroError,
  KOKORO_INSTALL_COMMAND,
  KOKORO_MODEL_DIRNAME,
  KOKORO_MAX_PENDING,
  KOKORO_MODEL_FILES,
  type KokoroErrorCode,
  type KokoroStatus,
  type KokoroSynthesizeRequest,
  type KokoroSynthesizeResult,
} from '@shared/kokoro';
import type { FromWorker, ToWorker } from './protocol';

/** The parts of Electron's UtilityProcess the service uses (injectable for tests). */
export interface WorkerHandle {
  postMessage(msg: ToWorker): void;
  on(event: 'message', cb: (msg: FromWorker) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  kill(): boolean;
}

export interface KokoroServiceOptions {
  /** Folder that contains the model folder (`<modelRoot>/Kokoro-82M-v1.0-ONNX`). */
  modelRoot: string;
  fork: () => WorkerHandle;
  /** Returns a problem description, or null when every model file is present and complete. */
  checkModel: (modelDir: string) => string | null;
  threads: number;
  onStatus?: (status: KokoroStatus) => void;
  /** Loading includes a warm-up run. */
  loadTimeoutMs?: number;
  /** Per request, from when the model is ready. */
  synthTimeoutMs?: number;
  /** After this many crashes the engine stays off for the session (the app falls back to system speech). */
  maxCrashes?: number;
}

interface Pending {
  resolve: (r: KokoroSynthesizeResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const kokoroError = (code: KokoroErrorCode, message: string) => new Error(encodeKokoroError(code, message));

/**
 * Owns the Kokoro utility process: checks the model is installed, starts the
 * process on first use, tracks readiness, relays synthesis requests, times out
 * stuck work, and restarts after a crash. Every failure rejects with a coded
 * error so the renderer can explain it and speak with the system voice instead.
 */
export class KokoroService {
  private worker: WorkerHandle | null = null;
  private state: KokoroStatus;
  private readonly pending = new Map<string, Pending>();
  private loaded: Promise<void> | null = null;
  private crashes = 0;
  private readonly opts: Required<Omit<KokoroServiceOptions, 'onStatus'>> & Pick<KokoroServiceOptions, 'onStatus'>;

  constructor(options: KokoroServiceOptions) {
    this.opts = { loadTimeoutMs: 120_000, synthTimeoutMs: 30_000, maxCrashes: 3, ...options };
    this.state = this.diskStatus();
  }

  get modelDir(): string {
    return `${this.opts.modelRoot}/${KOKORO_MODEL_DIRNAME}`;
  }

  status(): KokoroStatus {
    // Pick up an install (or removal) made while the app is running.
    if (this.state.state === 'missing' || this.state.state === 'installed') this.setStatus(this.diskStatus());
    return this.state;
  }

  /** Start the engine and load the model (no-op when ready). Resolves with the resulting status. */
  async prepare(): Promise<KokoroStatus> {
    try {
      await this.ensureLoaded();
    } catch {
      /* reflected in the status */
    }
    return this.state;
  }

  async synthesize(req: KokoroSynthesizeRequest): Promise<KokoroSynthesizeResult> {
    if (this.pending.has(req.id)) throw kokoroError('synthesis_failed', 'Duplicate request id');
    if (this.pending.size >= KOKORO_MAX_PENDING) throw kokoroError('synthesis_failed', 'Too many sentences are waiting to be spoken.');
    await this.ensureLoaded();
    const worker = this.worker;
    if (!worker) throw kokoroError('crashed', 'The local voice engine stopped.');
    return new Promise<KokoroSynthesizeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(req.id, kokoroError('timeout', 'The local voice took too long to respond.'));
        // A request stuck this long means the engine is unhealthy: start fresh next time.
        this.restart('The local voice engine stopped responding and was restarted.');
      }, this.opts.synthTimeoutMs);
      this.pending.set(req.id, { resolve, reject, timer });
      worker.postMessage({ type: 'synthesize', id: req.id, text: req.text, voice: req.voice, speed: req.speed });
    });
  }

  /** Drop queued requests (all, or the given ids). Their promises reject with `cancelled`. */
  cancel(ids?: string[]): void {
    const targets = ids ?? [...this.pending.keys()];
    if (targets.length === 0) return;
    this.worker?.postMessage({ type: 'cancel', ids: ids ?? 'all' });
    for (const id of targets) this.settle(id, kokoroError('cancelled', 'Cancelled'));
  }

  /**
   * Stop the engine and free the model's memory (~0.6-0.8 GB) when Kokoro isn't
   * in use. Pending requests reject with `cancelled`; the next request or
   * `prepare()` starts a fresh engine. Not counted as a crash.
   */
  release(): void {
    this.cancel();
    if (!this.worker) return;
    this.stopWorker();
    this.setStatus(this.diskStatus());
  }

  dispose(): void {
    this.cancel();
    this.stopWorker();
  }

  // ---------- internals ----------

  private diskStatus(): KokoroStatus {
    const problem = this.opts.checkModel(this.modelDir);
    if (problem) return { state: 'missing', message: `${problem} Install it with: ${KOKORO_INSTALL_COMMAND}` };
    return { state: 'installed' };
  }

  private setStatus(next: KokoroStatus): void {
    const prev = this.state;
    this.state = next;
    if (prev?.state !== next.state || prev.message !== next.message || prev.loadMs !== next.loadMs) this.opts.onStatus?.(next);
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return this.loaded;
    if (this.crashes >= this.opts.maxCrashes) {
      return Promise.reject(kokoroError('crashed', this.state.message ?? 'The local voice engine stopped.'));
    }
    const disk = this.diskStatus();
    if (disk.state === 'missing') {
      this.setStatus(disk);
      return Promise.reject(kokoroError('missing', disk.message ?? 'The Kokoro model is not installed.'));
    }

    this.setStatus({ state: 'loading' });
    const worker = this.opts.fork();
    this.worker = worker;
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(kokoroError('timeout', 'Loading the local voice took too long.'));
        this.failLoad('Loading the local voice took too long.');
      }, this.opts.loadTimeoutMs);
      worker.on('message', (msg) => {
        if (this.worker !== worker) return;
        if (msg.type === 'loaded') {
          clearTimeout(timer);
          this.setStatus({ state: 'ready', loadMs: msg.loadMs });
          resolve();
        } else if (msg.type === 'load-error') {
          clearTimeout(timer);
          reject(kokoroError('load_failed', msg.message));
          this.failLoad(`The local voice couldn't load: ${msg.message}`);
        } else {
          this.onWorkerMessage(msg);
        }
      });
      worker.on('exit', (code) => {
        if (this.worker !== worker) return;
        clearTimeout(timer);
        this.worker = null;
        this.loaded = null;
        this.crashes++;
        const message =
          this.crashes >= this.opts.maxCrashes
            ? `The local voice engine stopped (exit code ${code}) and is off until SignFlow restarts.`
            : `The local voice engine stopped (exit code ${code}). It restarts on next use.`;
        reject(kokoroError('crashed', message));
        this.rejectAll('crashed', message);
        this.setStatus({ state: 'error', message });
      });
    });
    loaded.catch(() => undefined);
    this.loaded = loaded;
    worker.postMessage({ type: 'load', modelRoot: `${this.opts.modelRoot}/`, modelDirName: KOKORO_MODEL_DIRNAME, threads: this.opts.threads });
    return loaded;
  }

  private onWorkerMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'result':
        this.settle(msg.id, null, { id: msg.id, wav: msg.wav, durationS: msg.durationS, synthMs: msg.synthMs });
        return;
      case 'error':
        this.settle(msg.id, kokoroError(msg.code, msg.message));
        return;
      case 'network-blocked':
        console.warn(`[kokoro] blocked a network request from the voice engine: ${msg.url}`);
        return;
      default:
        return;
    }
  }

  private settle(id: string, err: Error | null, result?: KokoroSynthesizeResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(result!);
  }

  private rejectAll(code: KokoroErrorCode, message: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, kokoroError(code, message));
  }

  private failLoad(message: string): void {
    this.stopWorker();
    this.rejectAll('load_failed', message);
    this.setStatus({ state: 'error', message });
  }

  private restart(message: string): void {
    this.stopWorker();
    this.rejectAll('crashed', message);
    this.setStatus({ ...this.diskStatus(), message });
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.loaded = null;
    worker?.kill();
  }
}

/** Check that every model file exists with the expected size (fast; hashes are checked at install). */
export function checkModelFiles(
  modelDir: string,
  stat: (path: string) => { size: number } | null,
): string | null {
  const missing: string[] = [];
  for (const f of KOKORO_MODEL_FILES) {
    const s = stat(`${modelDir}/${f.path}`);
    if (!s) missing.push(f.path);
    else if (s.size !== f.size) return `The Kokoro model file ${f.path} is incomplete or corrupt.`;
  }
  if (missing.length === KOKORO_MODEL_FILES.length) return 'The Kokoro voice model is not installed.';
  if (missing.length > 0) return `The Kokoro model is incomplete (missing ${missing.join(', ')}).`;
  return null;
}
