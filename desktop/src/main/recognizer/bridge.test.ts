// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecognizerEvent, RecognizerStatus } from '@shared/recognizer';
import { RecognizerBridge, type SocketLike } from './bridge';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  fail() {
    this.onerror?.({});
    this.readyState = 3;
    this.onclose?.({});
  }
}

const NOW = 1_794_708_460_000;
const sign = (gloss: string, extra: Record<string, unknown> = {}) => ({ type: 'sign', sign: gloss, confidence: 0.9, ts: NOW / 1000 - 1, ...extra });

function setup() {
  const sockets: FakeSocket[] = [];
  const events: RecognizerEvent[] = [];
  const statuses: RecognizerStatus[] = [];
  const log = vi.fn();
  const previews: unknown[] = [];
  let clock = NOW;
  const bridge = new RecognizerBridge({
    port: 8765,
    connect: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onPreview: (f) => previews.push(f),
    now: () => clock,
    log,
  });
  const tick = (ms: number) => (clock += ms);
  return { bridge, sockets, events, statuses, log, previews, tick, last: () => sockets.at(-1)! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RecognizerBridge', () => {
  it('connects only to the loopback recognizer, then relays validated events', () => {
    const { bridge, sockets, events, statuses, last } = setup();
    bridge.start({ allowKeyword: false });
    expect(sockets.map((s) => s.url)).toEqual(['ws://127.0.0.1:8765']);
    expect(statuses.at(-1)).toMatchObject({ state: 'connecting' });
    last().open();
    expect(statuses.at(-1)).toEqual({ state: 'ready' });
    last().message(sign('HELP'));
    last().message({ type: 'end_of_sentence', signs: ['HELP'], ts: NOW / 1000 });
    expect(events.map((e) => e.type)).toEqual(['sign', 'sentence-end']);
    expect(statuses.at(-1)).toEqual({ state: 'ready', model: 'demo14' });
  });

  it('drops malformed messages (and logs, rate-limited) without breaking the connection', () => {
    const { bridge, events, statuses, log, last } = setup();
    bridge.start({ allowKeyword: false });
    last().open();
    for (let i = 0; i < 20; i++) last().message('not json');
    last().message({ type: 'sign', sign: 'HELP', confidence: 7 });
    last().message(sign('YES'));
    expect(events).toHaveLength(1);
    expect(bridge.rejectedCount).toBe(21);
    expect(log).toHaveBeenCalledTimes(5);
    expect(statuses.at(-1)?.state).toBe('ready');
  });

  it('forwards a duplicated sign once', () => {
    const { bridge, events, last } = setup();
    bridge.start({ allowKeyword: false });
    last().open();
    const msg = sign('HELP');
    last().message(msg);
    last().message(msg);
    last().message(sign('HELP', { ts: NOW / 1000 })); // a new HELP (hands went down in between)
    expect(events).toHaveLength(2);
  });

  it('refuses the 116-sign keyword model unless the user opted in', () => {
    const keyword = { type: 'sign', candidates: [['HELP', 0.8]], top1: 'HELP', confident: true, ts: NOW / 1000 };
    const off = setup();
    off.bridge.start({ allowKeyword: false });
    off.last().open();
    off.last().message(keyword);
    expect(off.events).toHaveLength(0);
    expect(off.statuses.at(-1)).toMatchObject({ state: 'error', model: 'keyword116', message: expect.stringContaining('116-sign keyword model') });

    const on = setup();
    on.bridge.start({ allowKeyword: true });
    on.last().open();
    on.last().message(keyword);
    expect(on.events).toHaveLength(1);
    expect(on.statuses.at(-1)).toEqual({ state: 'ready', model: 'keyword116' });
  });

  it('keeps reconnecting with backoff while started (recognizer not up yet, or restarted)', () => {
    const { bridge, sockets, statuses, last } = setup();
    bridge.start({ allowKeyword: false });
    last().fail();
    expect(statuses.at(-1)).toMatchObject({ state: 'connecting', message: expect.stringContaining('python src/live.py') });
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    last().fail();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
    last().fail();
    vi.advanceTimersByTime(2000);
    last().fail();
    vi.advanceTimersByTime(3000); // capped at 3 s
    expect(sockets).toHaveLength(5);
    last().open(); // a successful connection resets the backoff
    last().fail();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(6);
  });

  it('a recognizer restart mid-session: reconnects and keeps relaying', () => {
    const { bridge, events, last } = setup();
    bridge.start({ allowKeyword: false });
    last().open();
    last().message(sign('HELP'));
    last().fail();
    vi.advanceTimersByTime(500);
    last().open();
    last().message(sign('DOCTOR'));
    expect(events.map((e) => e.type === 'sign' && e.sign.gloss)).toEqual(['HELP', 'DOCTOR']);
  });

  it('stop closes the socket, stops reconnecting, and ignores anything the old socket still delivers', () => {
    const { bridge, sockets, events, statuses, last } = setup();
    bridge.start({ allowKeyword: false });
    const s = last();
    s.open();
    bridge.stop();
    expect(s.closed).toBe(true);
    expect(statuses.at(-1)).toEqual({ state: 'idle' });
    s.message(sign('HELP'));
    s.fail();
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(0);
    expect(sockets).toHaveLength(1);

    // stop while waiting to reconnect
    bridge.start({ allowKeyword: false });
    last().fail();
    bridge.stop();
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(2);
  });

  it('a connect that throws is retried; start is idempotent', () => {
    let calls = 0;
    const statuses: RecognizerStatus[] = [];
    const bridge = new RecognizerBridge({
      port: 8765,
      connect: () => {
        calls++;
        throw new Error('ECONNREFUSED');
      },
      onEvent: () => undefined,
      onStatus: (s) => statuses.push(s),
      log: () => undefined,
    });
    bridge.start({ allowKeyword: false });
    bridge.start({ allowKeyword: false });
    expect(calls).toBe(1);
    vi.advanceTimersByTime(500);
    expect(calls).toBe(2);
    bridge.stop();
  });

  it('forwards preview frames throttled (at most one per 80 ms), never as sign events', () => {
    const { bridge, events, previews, tick, last } = setup();
    bridge.start({ allowKeyword: false });
    last().open();
    const frame = { type: 'preview', jpeg: '/9j/AAAA', width: 320, height: 180, ts: NOW / 1000 };
    last().message(frame);
    tick(30);
    last().message(frame); // dropped: too soon
    tick(60);
    last().message(frame);
    expect(previews).toHaveLength(2);
    expect(events).toHaveLength(0);
  });
});
