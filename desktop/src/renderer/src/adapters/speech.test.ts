import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampSpeechOptions, MockSpeechEngine, pickSystemVoice, WebSpeechEngine } from './speech';
import type { SpeechState, SpeechVoice, VoiceInUse } from './types';

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

const MAC_VOICES = [
  { voiceURI: 'v-sam', name: 'Samantha', lang: 'en-US', default: true },
  { voiceURI: 'v-dan', name: 'Daniel', lang: 'en-GB', default: false },
];

function fakeSynth(initialVoices = MAC_VOICES) {
  let voices = initialVoices;
  let onVoicesChanged: (() => void) | null = null;
  return {
    spoken: [] as FakeUtterance[],
    paused: false,
    getVoices: () => voices,
    loadVoices(next = MAC_VOICES) {
      voices = next;
      onVoicesChanged?.();
    },
    speak(u: FakeUtterance) {
      this.spoken.push(u);
      u.onstart?.();
    },
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    addEventListener: vi.fn((_type: string, cb: () => void) => {
      onVoicesChanged = cb;
    }),
  };
}

const v = (name: string, lang = 'en-US', isDefault = false): SpeechVoice => ({ id: `id-${name}`, name, lang, isDefault });

describe('pickSystemVoice', () => {
  it("keeps the user's choice when it is installed", () => {
    expect(pickSystemVoice([v('Samantha'), v('Daniel', 'en-GB')], 'id-Daniel')?.name).toBe('Daniel');
  });

  it('otherwise picks the most natural English voice, never a novelty one', () => {
    const mac = [v('Albert'), v('Bad News'), v('Thomas', 'fr-FR', true), v('Samantha'), v('Ava (Premium)'), v('Eddy (English (US))')];
    expect(pickSystemVoice(mac)?.name).toBe('Ava (Premium)');
    expect(pickSystemVoice(mac, 'id-missing')?.name).toBe('Ava (Premium)');
    expect(pickSystemVoice([v('Zarvox'), v('Samantha'), v('Daniel', 'en-GB')])?.name).toBe('Samantha');
    expect(pickSystemVoice([v('Moira', 'en-IE'), v('Thomas', 'fr-FR', true)])?.name).toBe('Moira');
    expect(pickSystemVoice([v('Karen (Enhanced)', 'en_AU'), v('Fred')])?.name).toBe('Karen (Enhanced)');
    expect(pickSystemVoice([])).toBeUndefined();
  });
});

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
  function make(voices = MAC_VOICES) {
    const synth = fakeSynth(voices);
    const engine = new WebSpeechEngine(
      synth as unknown as SpeechSynthesis,
      FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
      500,
    );
    const states: SpeechState[] = [];
    engine.onState((s) => states.push(s));
    const used: VoiceInUse[] = [];
    engine.onVoiceInUse((u) => used.push(u));
    return { synth, engine, states, used };
  }

  afterEach(() => vi.useRealTimers());

  it('without a chosen voice, uses the best English voice and reports it', () => {
    const { engine, synth, used } = make();
    engine.speak('Hi', { rate: 1, pitch: 1, volume: 1 });
    expect(synth.spoken[0]!.voice).toMatchObject({ name: 'Samantha' });
    expect(synth.spoken[0]!.lang).toBe('en-US');
    expect(used).toEqual([{ source: 'system', id: 'v-sam', name: 'Samantha', fallback: false }]);
  });

  it('waits for macOS voices to load before speaking, then uses them', () => {
    vi.useFakeTimers();
    const { engine, synth } = make([]);
    engine.speak('Hi', { rate: 1, pitch: 1, volume: 1 });
    expect(synth.spoken).toHaveLength(0);
    synth.loadVoices();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]!.voice).toMatchObject({ name: 'Samantha' });
    vi.advanceTimersByTime(1000);
    expect(synth.spoken).toHaveLength(1); // not spoken twice
  });

  it('speaks anyway (in US English) if voices never load, unless cancelled first', () => {
    vi.useFakeTimers();
    const { engine, synth } = make([]);
    engine.speak('Hi', { rate: 1, pitch: 1, volume: 1 });
    vi.advanceTimersByTime(500);
    expect(synth.spoken.map((u) => [u.text, u.lang])).toEqual([['Hi', 'en-US']]);

    engine.speak('Bye', { rate: 1, pitch: 1, volume: 1 });
    engine.cancel();
    vi.advanceTimersByTime(500);
    expect(synth.spoken).toHaveLength(1);
  });

  it('resumes a synth left paused, so new speech is not silently queued', () => {
    const { engine, synth } = make();
    synth.paused = true;
    engine.speak('Hi', { rate: 1, pitch: 1, volume: 1 });
    expect(synth.resume).toHaveBeenCalled();
    expect(synth.spoken).toHaveLength(1);
  });

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
