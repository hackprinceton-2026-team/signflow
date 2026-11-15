// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeKokoroError, KOKORO_MAX_PENDING, KOKORO_MODEL_FILES, type KokoroStatus } from '@shared/kokoro';
import { checkModelFiles, KokoroService, type WorkerHandle } from './service';
import type { FromWorker, ToWorker } from './protocol';

class FakeWorker implements WorkerHandle {
  readonly posted: ToWorker[] = [];
  private onMessage: ((m: FromWorker) => void) | null = null;
  private onExit: ((code: number) => void) | null = null;
  killed = false;
  postMessage(msg: ToWorker) {
    this.posted.push(msg);
  }
  on(event: 'message' | 'exit', cb: ((m: FromWorker) => void) | ((code: number) => void)) {
    if (event === 'message') this.onMessage = cb as (m: FromWorker) => void;
    else this.onExit = cb as (code: number) => void;
  }
  kill() {
    this.killed = true;
    return true;
  }
  emit(msg: FromWorker) {
    this.onMessage?.(msg);
  }
  exit(code: number) {
    this.onExit?.(code);
  }
  synthIds() {
    return this.posted.filter((m) => m.type === 'synthesize').map((m) => (m as { id: string }).id);
  }
}

function setup(opts: { installed?: boolean; synthTimeoutMs?: number; loadTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const statuses: KokoroStatus[] = [];
  let installed = opts.installed ?? true;
  const service = new KokoroService({
    modelRoot: '/models',
    fork: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    checkModel: () => (installed ? null : 'The Kokoro voice model is not installed.'),
    threads: 4,
    onStatus: (s) => statuses.push(s),
    synthTimeoutMs: opts.synthTimeoutMs ?? 30_000,
    loadTimeoutMs: opts.loadTimeoutMs ?? 120_000,
  });
  return { service, workers, statuses, install: (v: boolean) => (installed = v) };
}

const req = (id: string) => ({ id, text: 'I have never smoked.', voice: 'af_heart' as const, speed: 1 });
const result = (id: string): FromWorker => ({ type: 'result', id, wav: new Uint8Array([1, 2]), durationS: 1.2, synthMs: 340 });
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return decodeKokoroError((err as Error).message).code;
  }
};

afterEach(() => vi.useRealTimers());

describe('KokoroService', () => {
  it('model missing: says how to install, rejects with "missing", and never starts the engine', async () => {
    const { service, workers } = setup({ installed: false });
    expect(service.status()).toMatchObject({ state: 'missing', message: expect.stringContaining('npm run kokoro:install') });
    expect(await codeOf(service.synthesize(req('a')))).toBe('missing');
    expect(await service.prepare()).toMatchObject({ state: 'missing' });
    expect(workers).toHaveLength(0);
  });

  it('notices an install made while the app is running', () => {
    const { service, install } = setup({ installed: false });
    expect(service.status().state).toBe('missing');
    install(true);
    expect(service.status().state).toBe('installed');
  });

  it('starts the engine on first use, reports loading → ready, and relays results', async () => {
    const { service, workers, statuses } = setup();
    expect(service.status().state).toBe('installed');
    const pending = service.synthesize(req('a'));
    const w = workers[0]!;
    expect(w.posted[0]).toEqual({ type: 'load', modelRoot: '/models/', modelDirName: 'Kokoro-82M-v1.0-ONNX', threads: 4 });
    w.emit({ type: 'loaded', loadMs: 900 });
    await vi.waitFor(() => expect(w.synthIds()).toEqual(['a']));
    w.emit(result('a'));
    await expect(pending).resolves.toMatchObject({ id: 'a', durationS: 1.2, synthMs: 340 });
    expect(statuses.map((s) => s.state)).toEqual(['loading', 'ready']);
    expect(service.status()).toEqual({ state: 'ready', loadMs: 900 });

    // Already loaded: no second engine.
    void service.prepare();
    expect(workers).toHaveLength(1);
  });

  it('cancel rejects pending requests at once and tells the engine to drop them', async () => {
    const { service, workers } = setup();
    void service.prepare();
    workers[0]!.emit({ type: 'loaded', loadMs: 10 });
    const a = service.synthesize(req('a'));
    const b = service.synthesize(req('b'));
    await vi.waitFor(() => expect(workers[0]!.synthIds()).toEqual(['a', 'b']));
    service.cancel(['a']);
    expect(await codeOf(a)).toBe('cancelled');
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'cancel', ids: ['a'] });
    // A late result for a cancelled request is ignored.
    workers[0]!.emit(result('a'));
    service.cancel();
    expect(await codeOf(b)).toBe('cancelled');
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'cancel', ids: 'all' });
  });

  it('a crash rejects in-flight work, shows an error, and the next request restarts the engine', async () => {
    const { service, workers } = setup();
    const a = service.synthesize(req('a'));
    workers[0]!.emit({ type: 'loaded', loadMs: 10 });
    await vi.waitFor(() => expect(workers[0]!.synthIds()).toEqual(['a']));
    workers[0]!.exit(134);
    expect(await codeOf(a)).toBe('crashed');
    expect(service.status()).toMatchObject({ state: 'error', message: expect.stringContaining('restarts on next use') });

    const b = service.synthesize(req('b'));
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: 'loaded', loadMs: 10 });
    await vi.waitFor(() => expect(workers[1]!.synthIds()).toEqual(['b']));
    workers[1]!.emit(result('b'));
    await expect(b).resolves.toMatchObject({ id: 'b' });
  });

  it('stays off for the session after repeated crashes (the app keeps using the system voice)', async () => {
    const { service, workers } = setup();
    for (let i = 0; i < 3; i++) {
      void service.prepare();
      workers[i]!.exit(1);
    }
    expect(await codeOf(service.synthesize(req('z')))).toBe('crashed');
    expect(workers).toHaveLength(3);
    expect(service.status().message).toMatch(/off until SignFlow restarts/);
  });

  it('a load error is reported with the reason', async () => {
    const { service, workers } = setup();
    const a = service.synthesize(req('a'));
    workers[0]!.emit({ type: 'load-error', message: 'Protobuf parsing failed.' });
    expect(await codeOf(a)).toBe('load_failed');
    expect(service.status()).toMatchObject({ state: 'error', message: expect.stringContaining('Protobuf parsing failed.') });
    expect(workers[0]!.killed).toBe(true);
  });

  it('a stuck request times out and the engine is restarted', async () => {
    vi.useFakeTimers();
    const { service, workers } = setup({ synthTimeoutMs: 5000 });
    void service.prepare();
    workers[0]!.emit({ type: 'loaded', loadMs: 10 });
    const a = service.synthesize(req('a'));
    const code = codeOf(a);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await code).toBe('timeout');
    expect(workers[0]!.killed).toBe(true);
    void service.prepare();
    expect(workers).toHaveLength(2);
  });

  it('refuses work beyond the pending limit instead of queueing without bound', async () => {
    const { service, workers } = setup();
    void service.prepare();
    workers[0]!.emit({ type: 'loaded', loadMs: 10 });
    const queued = Array.from({ length: KOKORO_MAX_PENDING }, (_, i) => service.synthesize(req(`q${i}`)));
    for (const q of queued) q.catch(() => undefined);
    await vi.waitFor(() => expect(workers[0]!.synthIds()).toHaveLength(KOKORO_MAX_PENDING));
    expect(await codeOf(service.synthesize(req('one-too-many')))).toBe('synthesis_failed');
    service.cancel();
  });

  it('rejects a duplicate request id', async () => {
    const { service, workers } = setup();
    void service.synthesize(req('a')).catch(() => undefined);
    workers[0]!.emit({ type: 'loaded', loadMs: 10 });
    await vi.waitFor(() => expect(workers[0]!.synthIds()).toEqual(['a']));
    expect(await codeOf(service.synthesize(req('a')))).toBe('synthesis_failed');
  });
});

describe('checkModelFiles', () => {
  const sizes = Object.fromEntries(KOKORO_MODEL_FILES.map((f) => [`/m/${f.path}`, f.size]));
  const stat = (overrides: Record<string, number | null> = {}) => (p: string) => {
    const size = p in overrides ? overrides[p] : sizes[p];
    return size === null || size === undefined ? null : { size };
  };

  it('accepts a complete install', () => {
    expect(checkModelFiles('/m', stat())).toBeNull();
  });

  it('distinguishes not installed, incomplete, and corrupt', () => {
    expect(checkModelFiles('/m', () => null)).toBe('The Kokoro voice model is not installed.');
    expect(checkModelFiles('/m', stat({ '/m/tokenizer.json': null }))).toMatch(/incomplete \(missing tokenizer.json\)/);
    expect(checkModelFiles('/m', stat({ '/m/onnx/model.onnx': 1000 }))).toMatch(/onnx\/model.onnx is incomplete or corrupt/);
  });
});
