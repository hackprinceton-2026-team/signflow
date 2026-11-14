import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampSpeechOptions, MockSpeechEngine, WebSpeechEngine } from './speech';
import type { SpeechState } from './types';

class FakeUtterance {
  voice: unknown = null;
  lang = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onresume: (() => void) | null = null;
  constructor(public text: string) {}
}

function fakeSynth() {
  const voices = [
    { voiceURI: 'v-sam', name: 'Samantha', lang: 'en-US', default: true },
    { voiceURI: 'v-dan', name: 'Daniel', lang: 'en-GB', default: false },
  ];
  return {
    spoken: [] as FakeUtterance[],
    getVoices: () => voices,
    speak(u: FakeUtterance) {
      this.spoken.push(u);
      u.onstart?.();
    },
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    addEventListener: vi.fn(),
  };
}

describe('clampSpeechOptions', () => {
  it('clamps out-of-range and non-finite values', () => {
    expect(clampSpeechOptions({ rate: 50, pitch: -1, volume: Number.NaN })).toEqual({
      voiceId: undefined,
      rate: 10,
      pitch: 0,
      volume: 1,
    });
  });
});

describe('WebSpeechEngine', () => {
  function make() {
    const synth = fakeSynth();
    const engine = new WebSpeechEngine(
      synth as unknown as SpeechSynthesis,
      FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    );
    const states: SpeechState[] = [];
    engine.onState((s) => states.push(s));
    return { synth, engine, states };
  }

  it('maps system voices', () => {
    const { engine } = make();
    expect(engine.voices()).toEqual([
      { id: 'v-sam', name: 'Samantha', lang: 'en-US', isDefault: true },
      { id: 'v-dan', name: 'Daniel', lang: 'en-GB', isDefault: false },
    ]);
  });

  it('speaks with the chosen voice and options, then returns to idle', () => {
    const { engine, synth, states } = make();
    engine.speak('  Hello there  ', { voiceId: 'v-dan', rate: 1.5, pitch: 0.8, volume: 0.5 });
    const u = synth.spoken[0]!;
    expect(u.text).toBe('Hello there');
    expect(u.voice).toMatchObject({ name: 'Daniel' });
    expect(u.lang).toBe('en-GB');
    expect([u.rate, u.pitch, u.volume]).toEqual([1.5, 0.8, 0.5]);
    expect(states).toEqual(['speaking']);
    u.onend?.();
    expect(states).toEqual(['speaking', 'idle']);
  });

  it('ignores blank text', () => {
    const { engine, synth } = make();
    engine.speak('   ', { rate: 1, pitch: 1, volume: 1 });
    expect(synth.spoken).toHaveLength(0);
  });

  it('pause/resume/cancel drive the synth and state', () => {
    const { engine, synth, states } = make();
    engine.speak('Hi', { rate: 1, pitch: 1, volume: 1 });
    engine.pause();
    engine.resume();
    engine.cancel();
    expect(synth.pause).toHaveBeenCalled();
    expect(synth.resume).toHaveBeenCalled();
    expect(states).toEqual(['speaking', 'paused', 'speaking', 'idle']);
  });

  it('a stale utterance ending does not reset state of a newer one', () => {
    const { engine, synth, states } = make();
    engine.speak('First', { rate: 1, pitch: 1, volume: 1 });
    engine.speak('Second', { rate: 1, pitch: 1, volume: 1 });
    synth.spoken[0]!.onend?.();
    expect(states.at(-1)).toBe('speaking');
  });
});

describe('MockSpeechEngine', () => {
  afterEach(() => vi.useRealTimers());

  it('records speech and simulates duration', async () => {
    vi.useFakeTimers();
    const engine = new MockSpeechEngine(10);
    const states: SpeechState[] = [];
    engine.onState((s) => states.push(s));
    engine.speak('Hello', { rate: 1, pitch: 1, volume: 1 });
    expect(engine.spoken[0]?.text).toBe('Hello');
    engine.pause();
    engine.resume();
    await vi.advanceTimersByTimeAsync(300);
    expect(states).toEqual(['speaking', 'paused', 'speaking', 'idle']);
  });
});
