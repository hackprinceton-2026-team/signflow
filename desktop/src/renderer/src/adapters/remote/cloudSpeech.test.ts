import { describe, expect, it, vi } from 'vitest';
import { CloudSpeechEngine, FallbackSpeechEngine, type AudioLike } from './cloudSpeech';
import { createFakeBackend } from '../../test/fakeBackend';
import { MockSpeechEngine } from '../speech';
import type { SpeechState } from '../types';

class FakeAudio implements AudioLike {
  src = '';
  volume = 1;
  playbackRate = 1;
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
  return { backend, engine, audios, states, revoke };
}

describe('CloudSpeechEngine', () => {
  it('fetches /speak for exactly the given text and plays it', async () => {
    const { backend, engine, audios, states, revoke } = setup();
    await engine.play('  Thank you so much.  ', { ...opts, voiceId: 'Matthew' });
    expect(backend.callsTo('/speak').map((c) => c.body)).toEqual([{ text: 'Thank you so much.', voice_id: 'Matthew' }]);
    expect(audios[0]).toMatchObject({ src: 'blob:test', volume: 0.6, playbackRate: 1.25, muted: false });
    expect(audios[0]!.play).toHaveBeenCalled();
    expect(states).toEqual(['speaking']);
    audios[0]!.end();
    expect(states).toEqual(['speaking', 'idle']);
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });

  it('ignores system voice ids (lets the server pick its default)', async () => {
    const { backend, engine } = setup();
    await engine.play('Hi.', { ...opts, voiceId: 'com.apple.voice.Samantha' });
    expect(backend.callsTo('/speak')[0]!.body).toEqual({ text: 'Hi.' });
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
    new FallbackSpeechEngine(engine, system, onFallback).speak('Hello.', opts);
    await vi.waitFor(() => expect(backend.callsTo('/speak')).toHaveLength(1));
    expect(system.spoken).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('speaks the same confirmed text with the system voice if the cloud fails', async () => {
    const { engine } = setup(createFakeBackend({ offline: true }));
    const system = new MockSpeechEngine();
    const onFallback = vi.fn();
    new FallbackSpeechEngine(engine, system, onFallback).speak('I need help.', { ...opts, voiceId: 'Joanna' });
    await vi.waitFor(() => expect(system.spoken).toHaveLength(1));
    expect(system.spoken[0]!.text).toBe('I need help.');
    expect(system.spoken[0]!.opts.voiceId).toBeUndefined();
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'offline' }));
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
