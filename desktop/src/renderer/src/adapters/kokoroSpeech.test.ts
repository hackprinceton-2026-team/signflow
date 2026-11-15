import { describe, expect, it, vi } from 'vitest';
import { KokoroSpeechEngine, KokoroSpeechError } from './kokoroSpeech';
import { FallbackSpeechEngine } from './remote/cloudSpeech';
import { MockSpeechEngine } from './speech';
import { FakeAudio, FakeKokoro } from '../test/fakes';
import type { SpeechState, VoiceInUse } from './types';

const opts = { rate: 1, pitch: 1, volume: 0.7 };

function setup(bridge = new FakeKokoro(), extra: { muted?: boolean } = {}) {
  const audios: FakeAudio[] = [];
  const revoke = vi.fn();
  const engine = new KokoroSpeechEngine({
    bridge,
    createAudio: () => {
      const a = new FakeAudio();
      audios.push(a);
      return a;
    },
    createObjectURL: () => `blob:kokoro-${audios.length}`,
    revokeObjectURL: revoke,
    ...extra,
  });
  const states: SpeechState[] = [];
  engine.onState((s) => states.push(s));
  const used: VoiceInUse[] = [];
  engine.onVoiceInUse((v) => used.push(v));
  return { bridge, engine, audios, states, used, revoke };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('KokoroSpeechEngine', () => {
  it('synthesizes exactly the given text with the chosen voice and speed, plays it, and returns to idle', async () => {
    const { bridge, engine, audios, states, used, revoke } = setup();
    const done = engine.play('  I am allergic to penicillin.  ', { ...opts, kokoroVoiceId: 'af_bella', rate: 1.3 });
    expect(bridge.requests).toEqual([{ id: expect.any(String), text: 'I am allergic to penicillin.', voice: 'af_bella', speed: 1.3 }]);
    expect(states).toEqual(['speaking']);
    expect(audios).toHaveLength(0); // nothing plays before the audio exists

    bridge.respond();
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    const audio = audios[0]!;
    expect(audio.volume).toBe(0.7);
    expect(audio.playbackRate).toBe(1); // speed is applied by the model, keeping the natural pitch
    expect(audio.muted).toBe(false);
    await vi.waitFor(() => expect(used).toEqual([{ source: 'kokoro', id: 'af_bella', name: 'Bella', engine: 'kokoro', fallback: false }]));

    audio.end();
    await done;
    expect(states).toEqual(['speaking', 'idle']);
    expect(revoke).toHaveBeenCalled();
  });

  it('clamps speed to what Kokoro supports and defaults to Heart', async () => {
    const { bridge, engine } = setup();
    engine.speak('Hi.', { ...opts, rate: 4, kokoroVoiceId: 'nope' });
    expect(bridge.requests[0]).toMatchObject({ voice: 'af_heart', speed: 2 });
  });

  it('never synthesizes empty text', () => {
    const { bridge, engine, states } = setup();
    engine.speak('   ', opts);
    expect(bridge.synthesize).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it('queues every sentence at once and plays them in order, each after the previous ends', async () => {
    const { bridge, engine, audios } = setup();
    const done = engine.play('I have never smoked. My doctor’s appointment is tomorrow at three.', opts);
    expect(bridge.requests.map((r) => r.text)).toEqual(['I have never smoked.', 'My doctor’s appointment is tomorrow at three.']);
    bridge.respond(bridge.requests[1]!.id); // second ready first: must still wait
    await tick();
    expect(audios).toHaveLength(0);
    bridge.respond();
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    audios[0]!.end();
    await vi.waitFor(() => expect(audios).toHaveLength(2));
    audios[1]!.end();
    await done;
  });

  it('cancel during synthesis: nothing plays, queued work is dropped, and the late result is ignored', async () => {
    const { bridge, engine, audios, states } = setup();
    const done = engine.play('First sentence. Second sentence.', opts);
    const ids = bridge.requests.map((r) => r.id);
    engine.cancel();
    expect(bridge.cancel).toHaveBeenCalledWith(ids);
    await done; // resolves quietly
    expect(states).toEqual(['speaking', 'idle']);
    await tick();
    expect(audios).toHaveLength(0);
  });

  it('cancel during playback stops the audio at once', async () => {
    const { bridge, engine, audios, states } = setup();
    const done = engine.play('Hello there.', opts);
    bridge.respond();
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    engine.cancel();
    await done;
    expect(audios[0]!.pause).toHaveBeenCalled();
    expect(states.at(-1)).toBe('idle');
  });

  it('rapid requests never overlap: a newer text supersedes and cancels the older one', async () => {
    const { bridge, engine, audios } = setup();
    const first = engine.play('Old sentence.', opts);
    const second = engine.play('New sentence.', opts);
    await first;
    expect(bridge.cancel).toHaveBeenCalledWith([bridge.requests[0]!.id]);
    bridge.respond();
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    expect(bridge.requests.map((r) => r.text)).toEqual(['Old sentence.', 'New sentence.']);
    audios[0]!.end();
    await second;
    expect(audios).toHaveLength(1);
  });

  it('model missing: rejects with the full text to speak elsewhere, and returns to idle', async () => {
    const { engine, states, audios } = setup(new FakeKokoro({ state: 'missing' }));
    const err = await engine.play('I am allergic to penicillin.', opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KokoroSpeechError);
    expect(err).toMatchObject({ code: 'missing', remainingText: 'I am allergic to penicillin.' });
    expect(states).toEqual(['speaking', 'idle']);
    expect(audios).toHaveLength(0);
  });

  it('a failure part-way reports only the sentences not yet spoken', async () => {
    const { bridge, engine, audios } = setup();
    const done = engine.play('One. Two. Three.', opts).catch((e: unknown) => e);
    bridge.respond();
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    bridge.fail(bridge.requests[1]!.id, 'crashed', 'stopped');
    audios[0]!.end();
    expect(await done).toMatchObject({ code: 'crashed', remainingText: 'Two. Three.' });
    expect(bridge.cancel).toHaveBeenLastCalledWith([bridge.requests[2]!.id]);
  });

  it('an unavailable audio device is a playback failure (so the fallback voice can try)', async () => {
    const audios: FakeAudio[] = [];
    const bridge = new FakeKokoro();
    bridge.autoRespond = true;
    const engine = new KokoroSpeechEngine({
      bridge,
      createAudio: () => {
        const a = new FakeAudio();
        a.failWith = new Error('NotSupportedError: no audio output device');
        audios.push(a);
        return a;
      },
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => undefined,
    });
    const err = await engine.play('Hello.', opts).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'playback_failed', remainingText: 'Hello.' });
    expect((err as Error).message).toMatch(/no audio output device/);
  });

  it('pause between sentences holds the next one; resume continues without replaying', async () => {
    const { bridge, engine, audios, states } = setup();
    const done = engine.play('One. Two.', opts);
    bridge.respond();
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    audios[0]!.end();
    engine.pause();
    expect(states.at(-1)).toBe('paused');
    bridge.respond();
    await tick();
    expect(audios).toHaveLength(1);
    engine.resume();
    await vi.waitFor(() => expect(audios).toHaveLength(2));
    expect(audios[0]!.play).toHaveBeenCalledTimes(1); // the finished sentence never replays
    audios[1]!.end();
    await done;
    expect(states.at(-1)).toBe('idle');
  });

  it('plays muted in silent E2E runs (synthesis still happens)', async () => {
    const { bridge, engine, audios } = setup(new FakeKokoro(), { muted: true });
    engine.speak('Hi.', opts);
    bridge.respond();
    await vi.waitFor(() => expect(audios[0]?.muted).toBe(true));
  });

  it('describes the selected voice', () => {
    expect(setup().engine.describeVoice({ ...opts, kokoroVoiceId: 'am_michael' })).toBe('Michael · Kokoro (on-device neural)');
  });
});

describe('FallbackSpeechEngine with Kokoro first', () => {
  function chain(status = { state: 'ready' as const }) {
    const s = setup(new FakeKokoro(status));
    const system = new MockSpeechEngine();
    const onFallback = vi.fn();
    const fb = new FallbackSpeechEngine(s.engine, system, onFallback);
    const used: VoiceInUse[] = [];
    fb.onVoiceInUse((v) => used.push(v));
    return { ...s, system, onFallback, fb, used };
  }

  it('model missing: the system voice speaks the same confirmed text, marked as a fallback', async () => {
    const { fb, system, onFallback, used } = chain({ state: 'missing' } as never);
    fb.speak('I am allergic to penicillin.', { ...opts, voiceId: 'mock-voice' });
    await vi.waitFor(() => expect(system.spoken).toHaveLength(1));
    expect(system.spoken[0]).toMatchObject({ text: 'I am allergic to penicillin.', opts: { voiceId: 'mock-voice' } });
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ code: 'missing' }));
    expect(used).toEqual([{ source: 'system', id: 'mock-voice', name: 'Mock Voice', fallback: true }]);
  });

  it('a failure part-way: the system voice speaks only the rest', async () => {
    const { fb, bridge, audios, system } = chain();
    fb.speak('One. Two.', opts);
    bridge.respond();
    await vi.waitFor(() => expect(audios).toHaveLength(1));
    bridge.fail(undefined, 'synthesis_failed');
    audios[0]!.end();
    await vi.waitFor(() => expect(system.spoken.map((s) => s.text)).toEqual(['Two.']));
  });

  it('Stop while Kokoro is still synthesizing: a late failure never speaks stale text', async () => {
    const { fb, bridge, system, onFallback } = chain();
    fb.speak('Old text.', opts);
    const id = bridge.requests[0]!.id;
    fb.cancel();
    // Even if the engine reported an error after the cancel, nothing is spoken.
    expect(bridge.pending.find((p) => p.req.id === id)).toBeUndefined();
    await tick();
    expect(system.spoken).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('a newer sentence supersedes an older one whose failure arrives late', async () => {
    const bridge = new FakeKokoro();
    const primary = new KokoroSpeechEngine({ bridge, createAudio: () => new FakeAudio(), createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    // A primary whose first play() fails only after the second has started.
    let rejectFirst!: (e: Error) => void;
    let calls = 0;
    const play = vi.spyOn(primary, 'play').mockImplementation(() => {
      calls++;
      return calls === 1 ? new Promise<void>((_r, rej) => (rejectFirst = rej)) : Promise.resolve();
    });
    const system = new MockSpeechEngine();
    const fb = new FallbackSpeechEngine(primary, system);
    fb.speak('First.', opts);
    fb.speak('Second.', opts);
    rejectFirst(new KokoroSpeechError('crashed', 'stopped', 'First.'));
    await tick();
    expect(play).toHaveBeenCalledTimes(2);
    expect(system.spoken).toHaveLength(0);
  });
});
