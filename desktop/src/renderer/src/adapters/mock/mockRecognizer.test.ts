import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockSignRecognizer } from './mockRecognizer';
import type { AdapterStatus, RecognizedSign } from '../types';

describe('MockSignRecognizer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  function setup(opts: ConstructorParameters<typeof MockSignRecognizer>[0] = {}) {
    const rec = new MockSignRecognizer({
      phrases: [['HELLO', 'YOU'], ['THANK-YOU']],
      signIntervalMs: 100,
      phraseGapMs: 500,
      refineMs: 30,
      connectDelayMs: 50,
      noiseRate: 0,
      requireFrames: false,
      ...opts,
    });
    const signs: RecognizedSign[] = [];
    const statuses: AdapterStatus[] = [];
    rec.onSign((s) => signs.push(s));
    rec.onStatus((s) => statuses.push(s));
    return { rec, signs, statuses };
  }

  it('reports connecting → ready → idle', async () => {
    const { rec, statuses } = setup();
    const started = rec.start();
    expect(statuses.at(-1)?.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(50);
    await started;
    expect(statuses.at(-1)?.state).toBe('ready');
    rec.stop();
    expect(statuses.at(-1)?.state).toBe('idle');
  });

  it('emits a provisional then a final event per sign, in phrase order', async () => {
    const { rec, signs } = setup();
    void rec.start();
    await vi.advanceTimersByTimeAsync(50 + 100 + 30 + 100 + 30);
    const finals = signs.filter((s) => s.final);
    expect(finals.map((s) => s.gloss)).toEqual(['HELLO', 'YOU']);
    for (const f of finals) {
      const provisional = signs.find((s) => s.id === f.id && !s.final);
      expect(provisional).toBeDefined();
      expect(f.confidence).toBeGreaterThanOrEqual(0.78);
    }
    rec.stop();
  });

  it('pauses between phrases, then cycles to the next phrase', async () => {
    const { rec, signs } = setup();
    void rec.start();
    // connect + 2 signs + end-of-phrase tick + gap + next sign + refine
    await vi.advanceTimersByTimeAsync(50 + 100 * 3 + 500 + 30);
    expect(signs.filter((s) => s.final).map((s) => s.gloss)).toEqual(['HELLO', 'YOU', 'THANK-YOU']);
    rec.stop();
  });

  it('stays silent without fresh camera frames when requireFrames is on', async () => {
    const { rec, signs } = setup({ requireFrames: true, frameStaleMs: 200 });
    void rec.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(signs).toHaveLength(0);

    rec.pushFrame({ ts: Date.now(), width: 640, height: 480 });
    await vi.advanceTimersByTimeAsync(260);
    expect(signs.length).toBeGreaterThan(0);
    rec.stop();
  });

  it('emits nothing after stop()', async () => {
    const { rec, signs } = setup();
    void rec.start();
    await vi.advanceTimersByTimeAsync(160);
    rec.stop();
    const count = signs.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(signs).toHaveLength(count);
  });

  it('can inject low-confidence noise signs', async () => {
    const { rec, signs } = setup({ noiseRate: 1 });
    void rec.start();
    await vi.advanceTimersByTimeAsync(50 + 100 + 30);
    const noise = signs.filter((s) => s.final && s.confidence < 0.55);
    expect(noise.length).toBeGreaterThan(0);
    rec.stop();
  });

  it('ignores frames after stop, so a restart waits for fresh camera frames', async () => {
    const { rec, signs } = setup({ requireFrames: true, frameStaleMs: 1000, now: () => Date.now() });
    const started = rec.start();
    await vi.advanceTimersByTimeAsync(50);
    await started;
    rec.pushFrame({ ts: Date.now(), width: 640, height: 480 });
    await vi.advanceTimersByTimeAsync(100 + 30);
    expect(signs.length).toBeGreaterThan(0);

    rec.stop();
    const before = signs.length;
    rec.pushFrame({ ts: Date.now(), width: 640, height: 480 }); // a late frame after stop
    const restarted = rec.start();
    await vi.advanceTimersByTimeAsync(50);
    await restarted;
    await vi.advanceTimersByTimeAsync(600);
    expect(signs.length).toBe(before); // no frames since the restart: nothing emitted

    rec.pushFrame({ ts: Date.now(), width: 640, height: 480 });
    await vi.advanceTimersByTimeAsync(300);
    expect(signs.length).toBeGreaterThan(before);
    rec.stop();
  });

  it('is marked as simulated', () => {
    expect(setup().rec.simulated).toBe(true);
  });
});

