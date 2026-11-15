import { describe, expect, it, vi } from 'vitest';
import { CLOUD_SPEAK_TIMEOUT_MS, CLOUD_VOICES, CloudSpeechEngine, FallbackSpeechEngine, resolveCloudVoice, type AudioLike } from './cloudSpeech';
import { createFakeBackend } from '../../test/fakeBackend';
import { MockSpeechEngine } from '../speech';
import type { SpeechState, VoiceInUse } from '../types';

class FakeAudio implements AudioLike {
  src = '';
  volume = 1;
  playbackRate = 1;
  preservesPitch = false;
  muted = false;
  onended: AudioLike['onended'] = null;
  onerror: AudioLike['onerror'] = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  end() {
    this.onended?.call(this as unknown as HTMLAudioElement, new Event('ended'));
  }
}

const opts = { rate: 1.25, pitch: 1, volume: 0.6 };

function setup(backend = createFakeBackend()) {
  const audios: FakeAudio[] = [];
  const revoke = vi.fn();
  const engine = new CloudSpeechEngine({
    client: backend.client,
    createAudio: () => {
      const a = new FakeAudio();
      audios.push(a);
      return a;
    },
    createObjectURL: () => 'blob:test',
    revokeObjectURL: revoke,
  });
  const states: SpeechState[] = [];
  engine.onState((s) => states.push(s));
  const used: VoiceInUse[] = [];
  engine.onVoiceInUse((v) => used.push(v));
  return { backend, engine, audios, states, revoke, used };
}

describe('CloudSpeechEngine', () => {
  it('offers the Generative voices Ruth (default), Danielle and Matthew', () => {
    expect(CLOUD_VOICES.map((v) => v.id)).toEqual(['Ruth', 'Danielle', 'Matthew']);
    expect(resolveCloudVoice(undefined).id).toBe('Ruth');
    expect(resolveCloudVoice('Danielle').id).toBe('Danielle');
    expect(resolveCloudVoice('com.apple.voice.Samantha').id).toBe('Ruth');
  });

  it('fetches /speak for exactly the given text and plays it', async () => {
    const { backend, engine, audios, states, revoke, used } = setup();
    await engine.play('  Thank you so much.  ', { ...opts, cloudVoiceId: 'Matthew' });
    expect(backend.callsTo('/speak').map((c) => c.body)).toEqual([{ text: 'Thank you so much.', voice_id: 'Matthew' }]);
    expect(audios[0]).toMatchObject({ src: 'blob:test', volume: 0.6, playbackRate: 1.25, preservesPitch: true, muted: false });
    expect(used).toEqual([{ source: 'cloud', id: 'Matthew', name: 'Matthew', engine: 'generative', fallback: false }]);
    expect(audios[0]!.play).toHaveBeenCalled();
    expect(states).toEqual(['speaking']);
    audios[0]!.end();
    expect(states).toEqual(['speaking', 'idle']);
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });

  it('uses Ruth unless another offered cloud voice was picked; the system voice never leaks in', async () => {
    const { backend, engine } = setup();
    await engine.play('Hi.', { ...opts, voiceId: 'com.apple.voice.Samantha' });
    await engine.play('Hi.', { ...opts, cloudVoiceId: 'Joanna' });
    expect(backend.callsTo('/speak').map((c) => c.body)).toEqual([
      { text: 'Hi.', voice_id: 'Ruth' },
      { text: 'Hi.', voice_id: 'Ruth' },
    ]);
  });

  it('reports the engine the backend actually used', async () => {
    const backend = createFakeBackend();
    backend.fetch.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ audio_base64: btoa('ID3'), audio_format: 'mp3', voice_id: 'Ruth', engine: 'neural' }), { status: 200 }),
    );
    const { engine, used } = setup(backend);
    await engine.play('Hi.', opts);
    expect(used[0]).toMatchObject({ id: 'Ruth', engine: 'neural' });
  });

  it('gives up on a slow cloud voice so the fallback can speak', async () => {
    vi.useFakeTimers();
    try {
      const backend = createFakeBackend();
      backend.fetch.mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
      );
      const { engine } = setup(backend);
      const played = engine.play('Hi.', opts);
      const check = expect(played).rejects.toMatchObject({ kind: 'timeout' });
      await vi.advanceTimersByTimeAsync(CLOUD_SPEAK_TIMEOUT_MS + 1);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });

  it('pause/resume/cancel control playback', async () => {
    const { engine, audios, states } = setup();
    await engine.play('Hi.', opts);
    engine.pause();
    engine.resume();
    engine.cancel();
    expect(audios[0]!.pause).toHaveBeenCalled();
    expect(states).toEqual(['speaking', 'paused', 'speaking', 'idle']);
  });

  it('rejects when the backend fails, and returns to idle', async () => {
    const { engine, states } = setup(createFakeBackend({ speechConfigured: false }));
    await expect(engine.play('Hi.', opts)).rejects.toMatchObject({ kind: 'not_configured' });
    expect(states).toEqual(['speaking', 'idle']);
  });

  it('a newer request supersedes an older one', async () => {
    const { engine, audios } = setup();
    const first = engine.play('First.', opts);
    const second = engine.play('Second.', opts);
    await Promise.all([first, second]);
    expect(audios).toHaveLength(1);
  });

  it('ignores blank text', async () => {
    const { backend, engine } = setup();
    await engine.play('   ', opts);
    expect(backend.calls).toHaveLength(0);
  });
});

describe('FallbackSpeechEngine', () => {
  it('uses the cloud voice when it works', async () => {
    const { backend, engine } = setup();
    const system = new MockSpeechEngine();
    const onFallback = vi.fn();
    const fb = new FallbackSpeechEngine(engine, system, onFallback);
    const used: VoiceInUse[] = [];
    fb.onVoiceInUse((v) => used.push(v));
    fb.speak('Hello.', opts);
    await vi.waitFor(() => expect(used).toHaveLength(1));
    expect(backend.callsTo('/speak')).toHaveLength(1);
    expect(used[0]).toMatchObject({ source: 'cloud', name: 'Ruth', engine: 'generative', fallback: false });
    expect(system.spoken).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('speaks the same confirmed text with the chosen system voice if the cloud fails, and says so', async () => {
    const { engine } = setup(createFakeBackend({ offline: true }));
    const system = new MockSpeechEngine();
    const onFallback = vi.fn();
    const fb = new FallbackSpeechEngine(engine, system, onFallback);
    const used: VoiceInUse[] = [];
    fb.onVoiceInUse((v) => used.push(v));
    fb.speak('I need help.', { ...opts, voiceId: 'mock-voice', cloudVoiceId: 'Danielle' });
    await vi.waitFor(() => expect(system.spoken).toHaveLength(1));
    expect(system.spoken[0]!.text).toBe('I need help.');
    expect(system.spoken[0]!.opts.voiceId).toBe('mock-voice');
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'offline' }));
    expect(used).toEqual([{ source: 'system', id: 'mock-voice', name: 'Mock Voice', fallback: true }]);
  });

  it('lists the system voices, so the fallback voice can be chosen', () => {
    const { engine } = setup();
    const system = new MockSpeechEngine();
    expect(new FallbackSpeechEngine(engine, system).voices()).toEqual(system.voices());
  });

  it('merges state from both engines and unsubscribes cleanly', () => {
    const { engine } = setup();
    const system = new MockSpeechEngine();
    const fb = new FallbackSpeechEngine(engine, system);
    const states: SpeechState[] = [];
    const off = fb.onState((s) => states.push(s));
    system.speak('x', opts);
    off();
    system.cancel();
    expect(states).toEqual(['speaking']);
  });
});
