// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { KokoroWorkerCore, type Tts } from './workerCore';
import type { FromWorker } from './protocol';

const SR = 24_000;
const speech = () => {
  const a = new Float32Array(SR); // 0.3 s silence, 0.4 s "speech", 0.3 s silence
  for (let i = 0.3 * SR; i < 0.7 * SR; i++) a[i] = 0.4;
  return a;
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(generate: Tts['generate'] = async () => ({ audio: speech(), sampling_rate: SR })) {
  const sent: FromWorker[] = [];
  const tts: Tts = { generate: vi.fn(generate) };
  const load = deferred<Tts>();
  const loadTts = vi.fn(() => load.promise);
  const core = new KokoroWorkerCore(loadTts, (m) => sent.push(m));
  core.handle({ type: 'load', modelRoot: '/models/', modelDirName: 'Kokoro', threads: 4 });
  return { core, sent, tts, load, loadTts };
}

const job = (id: string, text = 'Hello.') => ({ type: 'synthesize' as const, id, text, voice: 'af_heart' as const, speed: 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('KokoroWorkerCore', () => {
  it('loads once, then synthesizes queued requests in order as trimmed 16-bit WAV', async () => {
    const { core, sent, tts, load, loadTts } = setup();
    core.handle(job('a', 'First.'));
    core.handle(job('b', 'Second.'));
    core.handle({ type: 'load', modelRoot: '/models/', modelDirName: 'Kokoro', threads: 4 });
    expect(loadTts).toHaveBeenCalledTimes(1);
    load.resolve(tts);
    await vi.waitFor(() => expect(sent.filter((m) => m.type === 'result')).toHaveLength(2));
    expect(sent[0]).toMatchObject({ type: 'loaded' });
    const results = sent.filter((m) => m.type === 'result');
    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(vi.mocked(tts.generate).mock.calls.map((c) => c[0])).toEqual(['First.', 'Second.']);
    const first = results[0]!;
    // 0.4 s of sound + 40 ms lead + 150 ms tail, not the full second.
    expect(first.durationS).toBeCloseTo(0.59, 2);
    expect(String.fromCharCode(...first.wav.slice(0, 4))).toBe('RIFF');
  });

  it('drops cancelled requests before they reach the model', async () => {
    const { core, sent, tts, load } = setup();
    core.handle(job('a'));
    core.handle(job('b'));
    core.handle(job('c'));
    core.handle({ type: 'cancel', ids: ['b'] });
    load.resolve(tts);
    await vi.waitFor(() => expect(sent.filter((m) => m.type === 'result')).toHaveLength(2));
    expect(sent).toContainEqual({ type: 'error', id: 'b', code: 'cancelled', message: 'Cancelled' });
    expect(tts.generate).toHaveBeenCalledTimes(2);
  });

  it('discards the result of a request cancelled while inside the model', async () => {
    const gate = deferred<{ audio: Float32Array; sampling_rate: number }>();
    const { core, sent, tts, load } = setup(() => gate.promise);
    load.resolve(tts);
    core.handle(job('a'));
    await vi.waitFor(() => expect(tts.generate).toHaveBeenCalled());
    core.handle({ type: 'cancel', ids: 'all' });
    gate.resolve({ audio: speech(), sampling_rate: SR });
    await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: 'error', id: 'a', code: 'cancelled', message: 'Cancelled' }));
    expect(sent.some((m) => m.type === 'result')).toBe(false);
  });

  it('reports a load failure for every waiting request, and can load again later', async () => {
    const { core, sent, load, loadTts, tts } = setup();
    core.handle(job('a'));
    core.handle(job('b'));
    load.reject(new Error('model.onnx is corrupt'));
    await vi.waitFor(() => expect(sent.filter((m) => m.type === 'error')).toHaveLength(2));
    expect(sent).toContainEqual({ type: 'load-error', message: 'model.onnx is corrupt' });
    expect(sent.filter((m) => m.type === 'error').every((m) => m.type === 'error' && m.code === 'load_failed')).toBe(true);

    loadTts.mockResolvedValueOnce(tts);
    core.handle({ type: 'load', modelRoot: '/models/', modelDirName: 'Kokoro', threads: 4 });
    core.handle(job('c'));
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'result', id: 'c' }));
  });

  it('reports a synthesis failure and keeps serving the next request', async () => {
    let calls = 0;
    const { core, sent, tts, load } = setup(async () => {
      if (++calls === 1) throw new Error('ORT failure');
      return { audio: speech(), sampling_rate: SR };
    });
    load.resolve(tts);
    core.handle(job('a'));
    core.handle(job('b'));
    await flush();
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'result', id: 'b' }));
    expect(sent).toContainEqual({ type: 'error', id: 'a', code: 'synthesis_failed', message: 'ORT failure' });
  });

  it('treats an all-silent output as a failure, not as empty audio', async () => {
    const { core, sent, tts, load } = setup(async () => ({ audio: new Float32Array(SR), sampling_rate: SR }));
    load.resolve(tts);
    core.handle(job('a'));
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'error', id: 'a', code: 'synthesis_failed' }));
  });
});
