import { vi } from 'vitest';
import { Emitter } from '../adapters/emitter';
import type { AdapterStatus, RecognizedSign, SignRecognizer, VideoFrameInput } from '../adapters/types';

/** A recognizer tests drive by hand. */
export class FakeRecognizer implements SignRecognizer {
  readonly name = 'Fake recognizer';
  readonly frameFormat = 'none' as const;
  readonly signs = new Emitter<RecognizedSign>();
  readonly status = new Emitter<AdapterStatus>();
  frames: VideoFrameInput[] = [];
  start = vi.fn(async () => this.status.emit({ state: 'ready' }));
  stop = vi.fn(() => this.status.emit({ state: 'idle' }));
  pushFrame(frame: VideoFrameInput) {
    this.frames.push(frame);
  }
  onSign(cb: (s: RecognizedSign) => void) {
    return this.signs.on(cb);
  }
  onStatus(cb: (s: AdapterStatus) => void) {
    return this.status.on(cb);
  }
  emit(gloss: string, confidence = 0.9, opts: Partial<RecognizedSign> = {}): RecognizedSign {
    const sign: RecognizedSign = {
      id: opts.id ?? `${gloss}-${Math.random().toString(36).slice(2)}`,
      gloss,
      confidence,
      ts: Date.now(),
      final: true,
      ...opts,
    };
    this.signs.emit(sign);
    return sign;
  }
}

class FakeTrack {
  readyState = 'live';
  private listeners: Record<string, (() => void)[]> = {};
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  getSettings() {
    return { deviceId: 'cam-1', width: 1280, height: 720 };
  }
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  fire(type: string) {
    this.listeners[type]?.forEach((cb) => cb());
  }
}

export class FakeMediaStream {
  readonly track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
}

/** Installs navigator.mediaDevices + HTMLMediaElement.play for jsdom. */
export function installFakeMediaDevices(
  impl: { getUserMedia?: () => Promise<unknown> } = {},
): { getUserMedia: ReturnType<typeof vi.fn>; streams: FakeMediaStream[] } {
  const streams: FakeMediaStream[] = [];
  const getUserMedia = vi.fn(
    impl.getUserMedia ??
      (async () => {
        const s = new FakeMediaStream();
        streams.push(s);
        return s;
      }),
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime HD Camera', groupId: 'g' },
        { kind: 'videoinput', deviceId: 'cam-2', label: 'USB Webcam', groupId: 'g2' },
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic', groupId: 'g' },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  return { getUserMedia, streams };
}
