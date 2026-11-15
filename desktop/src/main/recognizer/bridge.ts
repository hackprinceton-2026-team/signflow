import {
  parseRecognizerMessage,
  RECOGNIZER_HOST,
  type RecognizerEvent,
  type RecognizerModel,
  type RecognizerPreview,
  type RecognizerStatus,
} from '@shared/recognizer';

/** The parts of a WebSocket the bridge uses (Node's global WebSocket; a fake in tests). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface RecognizerBridgeOptions {
  port: number;
  connect: (url: string) => SocketLike;
  onEvent: (event: RecognizerEvent) => void;
  onStatus: (status: RecognizerStatus) => void;
  /** Camera preview frames from SignFlow's recognizer launcher (throttled). */
  onPreview?: (frame: RecognizerPreview) => void;
  now?: () => number;
  /** At most one preview frame per this many ms reaches the window. */
  previewIntervalMs?: number;
  /** Reconnect delays: start, then doubling up to the max. */
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Malformed messages logged at most this often. */
  log?: (message: string) => void;
}

const DEDUPE_WINDOW = 64;

/**
 * Electron-main client for the local ASL recognizer (ws://127.0.0.1:8765).
 *
 * - Connects only to loopback; it opens no listener of its own.
 * - Every message is untrusted: size-limited, parsed, validated and normalized
 *   by `parseRecognizerMessage`; anything else is dropped (and counted).
 * - The same sign delivered twice (same id) is forwarded once.
 * - Keyword-model (116-sign) messages are refused unless the user opted in.
 * - While started, it reconnects with backoff (the recognizer may start later
 *   than the app, or restart); `stop()` closes and stops reconnecting.
 */
export class RecognizerBridge {
  private socket: SocketLike | null = null;
  private wanted = false;
  private allowKeyword = false;
  private retryMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly recent: string[] = [];
  private status: RecognizerStatus = { state: 'idle' };
  private model: RecognizerModel | undefined;
  private rejected = 0;
  private lastPreviewAt = -Infinity;
  private readonly opts: Required<RecognizerBridgeOptions>;

  constructor(options: RecognizerBridgeOptions) {
    this.opts = {
      now: () => Date.now(),
      retryMinMs: 500,
      retryMaxMs: 3000,
      log: (m) => console.warn(`[recognizer] ${m}`),
      onPreview: () => undefined,
      previewIntervalMs: 80,
      ...options,
    };
    this.retryMs = this.opts.retryMinMs;
  }

  get url(): string {
    return `ws://${RECOGNIZER_HOST}:${this.opts.port}`;
  }

  get rejectedCount(): number {
    return this.rejected;
  }

  currentStatus(): RecognizerStatus {
    return this.status;
  }

  start(opts: { allowKeyword: boolean }): RecognizerStatus {
    this.allowKeyword = opts.allowKeyword;
    if (this.wanted) return this.status;
    this.wanted = true;
    this.recent.length = 0;
    this.model = undefined;
    this.retryMs = this.opts.retryMinMs;
    this.open();
    return this.status;
  }

  stop(): void {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.drop();
    this.setStatus({ state: 'idle' });
  }

  private open(): void {
    if (!this.wanted) return;
    this.setStatus({ state: 'connecting', message: `Waiting for the SignFlow ASL recognizer on ${this.url}…` });
    let socket: SocketLike;
    try {
      socket = this.opts.connect(this.url);
    } catch (err) {
      this.retry(err instanceof Error ? err.message : String(err));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retryMs = this.opts.retryMinMs;
      this.setStatus({ state: 'ready', ...(this.model ? { model: this.model } : {}) });
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.receive(ev.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.retry();
    };
    // An error is always followed by close; nothing to do here beyond not throwing.
    socket.onerror = () => undefined;
  }

  private retry(reason?: string): void {
    if (!this.wanted) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.opts.retryMaxMs, this.retryMs * 2);
    if (reason) this.opts.log(`connect failed: ${reason}`);
    this.setStatus({
      state: 'connecting',
      message: `Waiting for the SignFlow ASL recognizer on ${this.url}. Start it with: python src/live.py`,
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  private receive(data: unknown): void {
    const parsed = parseRecognizerMessage(data, this.opts.now());
    if (!parsed.ok) {
      this.rejected++;
      if (this.rejected <= 5 || this.rejected % 50 === 0) this.opts.log(`dropped message (${parsed.reason}); ${this.rejected} so far`);
      return;
    }
    if ('preview' in parsed) {
      const now = this.opts.now();
      if (now - this.lastPreviewAt < this.opts.previewIntervalMs) return; // throttle
      this.lastPreviewAt = now;
      if (this.status.state !== 'ready' && this.status.state !== 'error') this.setStatus({ state: 'ready', ...(this.model ? { model: this.model } : {}) });
      this.opts.onPreview(parsed.preview);
      return;
    }
    const { event } = parsed;
    const model = event.type === 'sign' ? event.sign.model : event.model;
    if (model === 'keyword116' && !this.allowKeyword) {
      this.setStatus({
        state: 'error',
        model,
        message:
          'The recognizer is running the 116-sign keyword model. Turn on "Allow the 116-sign keyword model" in Settings › Recognition, or restart it without --keyword.',
      });
      return;
    }
    if (model !== this.model) {
      this.model = model;
      this.setStatus({ state: 'ready', model });
    } else if (this.status.state !== 'ready') {
      this.setStatus({ state: 'ready', model });
    }
    if (event.type === 'sign') {
      if (this.recent.includes(event.sign.id)) return;
      this.recent.push(event.sign.id);
      if (this.recent.length > DEDUPE_WINDOW) this.recent.shift();
    }
    this.opts.onEvent(event);
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  private setStatus(next: RecognizerStatus): void {
    const prev = this.status;
    if (prev.state === next.state && prev.message === next.message && prev.model === next.model) return;
    this.status = next;
    this.opts.onStatus(next);
  }
}
