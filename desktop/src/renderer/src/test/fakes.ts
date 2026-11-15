import { encodeKokoroError, type KokoroErrorCode, type KokoroStatus, type KokoroSynthesizeRequest, type KokoroSynthesizeResult } from '@shared/kokoro';
import type { KokoroBridge } from '../adapters/kokoroSpeech';
import type { RecognizerBridge } from '../adapters/external/aslRecognizer';
import { parseRecognizerMessage, type RecognizerEvent, type RecognizerPreview, type RecognizerStatus } from '@shared/recognizer';
import type { AudioLike } from '../adapters/remote/cloudSpeech';
import { vi, type Mock } from 'vitest';
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

// ---------- Kokoro ----------

/** An <audio> stand-in: `play()` resolves (or rejects with `failWith`), `end()` finishes it. */
export class FakeAudio implements AudioLike {
  src = '';
  volume = 1;
  playbackRate = 1;
  preservesPitch = false;
  muted = false;
  onended: AudioLike['onended'] = null;
  onerror: AudioLike['onerror'] = null;
  failWith: Error | null = null;
  play: Mock<() => Promise<void>> = vi.fn(async () => {
    if (this.failWith) throw this.failWith;
  });
  pause: Mock<() => void> = vi.fn();
  end() {
    this.onended?.call(this as unknown as HTMLAudioElement, new Event('ended'));
  }
}

interface PendingSynthesis {
  req: KokoroSynthesizeRequest;
  resolve: (r: KokoroSynthesizeResult) => void;
  reject: (e: Error) => void;
}

/**
 * A controllable `window.signflow.kokoro`. Requests stay pending until the test
 * calls `respond()`/`fail()` (or set `autoRespond`). `cancel()` rejects pending
 * requests with the same coded error the main process uses.
 */
export class FakeKokoro implements KokoroBridge {
  current: KokoroStatus;
  autoRespond = false;
  /** Every request ever made, in order. */
  readonly requests: KokoroSynthesizeRequest[] = [];
  readonly pending: PendingSynthesis[] = [];
  private readonly listeners = new Set<(s: KokoroStatus) => void>();
  /** What `prepare()` moves the status to (default: ready, unless missing). */
  prepareResult: KokoroStatus | null = null;

  constructor(status: KokoroStatus = { state: 'ready', loadMs: 1234 }) {
    this.current = status;
  }

  status: Mock<KokoroBridge['status']> = vi.fn(async () => this.current);
  prepare: Mock<KokoroBridge['prepare']> = vi.fn(async () => {
    if (this.prepareResult) this.setStatus(this.prepareResult);
    return this.current;
  });
  synthesize: Mock<KokoroBridge['synthesize']> = vi.fn((req: KokoroSynthesizeRequest) => {
    this.requests.push(req);
    if (this.current.state === 'missing') return Promise.reject(new Error(encodeKokoroError('missing', 'The Kokoro voice model is not installed.')));
    return new Promise<KokoroSynthesizeResult>((resolve, reject) => {
      this.pending.push({ req, resolve, reject });
      if (this.autoRespond) queueMicrotask(() => this.respond(req.id));
    });
  });
  cancel: Mock<KokoroBridge['cancel']> = vi.fn(async (ids?: string[]) => {
    for (const p of [...this.pending]) {
      if (!ids || ids.includes(p.req.id)) this.fail(p.req.id, 'cancelled', 'Cancelled');
    }
  });
  release: Mock<KokoroBridge['release']> = vi.fn(async () => {
    await this.cancel();
    if (this.current.state === 'ready' || this.current.state === 'loading') this.setStatus({ state: 'installed' });
  });
  onStatus: Mock<KokoroBridge['onStatus']> = vi.fn((cb: (s: KokoroStatus) => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  });

  setStatus(status: KokoroStatus): void {
    this.current = status;
    for (const l of this.listeners) l(status);
  }

  private take(id?: string): PendingSynthesis {
    const i = id === undefined ? 0 : this.pending.findIndex((p) => p.req.id === id);
    const p = this.pending[i];
    if (!p) throw new Error(`No pending Kokoro request ${id ?? ''}`);
    this.pending.splice(i, 1);
    return p;
  }

  /** Resolve the oldest pending request (or the one with `id`) with a tiny WAV. */
  respond(id?: string): void {
    const p = this.take(id);
    p.resolve({ id: p.req.id, wav: new Uint8Array([82, 73, 70, 70]), durationS: 1.5, synthMs: 300 });
  }

  fail(id: string | undefined, code: KokoroErrorCode, message = 'boom'): void {
    const p = this.take(id);
    p.reject(new Error(`Error invoking remote method 'kokoro:synthesize': Error: ${encodeKokoroError(code, message)}`));
  }
}

// ---------- Local ASL recognizer ----------

/**
 * A controllable `window.signflow.recognizer`. `send()` takes the recognizer's
 * raw wire JSON and runs it through the same parser as the main process, so
 * tests exercise real messages end to end.
 */
export class FakeRecognizerBridge implements RecognizerBridge {
  private readonly events = new Set<(e: RecognizerEvent) => void>();
  private readonly statuses = new Set<(s: RecognizerStatus) => void>();
  private readonly previews = new Set<(f: RecognizerPreview) => void>();
  current: RecognizerStatus = { state: 'idle' };
  /** What start() connects to. */
  startResult: RecognizerStatus = { state: 'ready', model: 'demo14' };
  allowKeyword: boolean | null = null;

  start: Mock<RecognizerBridge['start']> = vi.fn(async (req: { allowKeyword: boolean }) => {
    this.allowKeyword = req.allowKeyword;
    this.setStatus(this.startResult);
    return this.current;
  });
  stop: Mock<RecognizerBridge['stop']> = vi.fn(async () => {
    this.setStatus({ state: 'idle' });
  });
  status: Mock<RecognizerBridge['status']> = vi.fn(async () => this.current);
  onEvent: Mock<RecognizerBridge['onEvent']> = vi.fn((cb: (e: RecognizerEvent) => void) => {
    this.events.add(cb);
    return () => void this.events.delete(cb);
  });
  onStatus: Mock<RecognizerBridge['onStatus']> = vi.fn((cb: (s: RecognizerStatus) => void) => {
    this.statuses.add(cb);
    return () => void this.statuses.delete(cb);
  });

  onPreview: Mock<RecognizerBridge['onPreview']> = vi.fn((cb: (f: RecognizerPreview) => void) => {
    this.previews.add(cb);
    return () => void this.previews.delete(cb);
  });

  /** Deliver a preview frame (already validated, as the main process forwards it). */
  sendPreview(frame: RecognizerPreview): void {
    for (const cb of this.previews) cb(frame);
  }

  get listening(): boolean {
    return this.events.size > 0;
  }

  setStatus(s: RecognizerStatus): void {
    this.current = s;
    for (const cb of this.statuses) cb(s);
  }

  emit(event: RecognizerEvent): void {
    for (const cb of this.events) cb(event);
  }

  /** Deliver one raw recognizer message (as live.py sends it). Returns false if the parser dropped it. */
  send(raw: string | Record<string, unknown>, now = Date.now()): boolean {
    const parsed = parseRecognizerMessage(typeof raw === 'string' ? raw : JSON.stringify(raw), now);
    if (!parsed.ok || !('event' in parsed)) return false;
    this.emit(parsed.event);
    return true;
  }
}
