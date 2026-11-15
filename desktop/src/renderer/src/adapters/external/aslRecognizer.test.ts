import { describe, expect, it, vi } from 'vitest';
import { AslRecognizer } from './aslRecognizer';
import { FakeRecognizerBridge } from '../../test/fakes';
import type { AdapterStatus, RecognizedSign, SignRecognizer } from '../types';

const now = Date.now();
const sec = (ms: number) => ms / 1000;

function setup(allowKeyword = false) {
  const bridge = new FakeRecognizerBridge();
  const rec = new AslRecognizer(bridge, { allowKeyword });
  const signs: RecognizedSign[] = [];
  const statuses: AdapterStatus[] = [];
  const ends = vi.fn();
  rec.onSign((s) => signs.push(s));
  rec.onStatus((s) => statuses.push(s));
  rec.onSentenceEnd((): void => ends());
  return { bridge, rec, signs, statuses, ends };
}

describe('AslRecognizer', () => {
  it('owns the camera and takes no frames', () => {
    const { rec } = setup();
    expect(rec.ownsCamera).toBe(true);
    expect(rec.frameFormat).toBe('none');
    expect((rec as SignRecognizer).simulated).toBeUndefined(); // a real model: no "simulated" labels
    rec.pushFrame({ ts: 0, width: 1, height: 1 }); // a no-op, never throws
  });

  it('start connects through the main process (with the keyword opt-in) and reports readiness', async () => {
    const { bridge, rec, statuses } = setup(true);
    await rec.start();
    expect(bridge.start).toHaveBeenCalledWith({ allowKeyword: true });
    expect(statuses).toEqual([
      { state: 'connecting', message: 'Connecting to the SignFlow ASL recognizer…' },
      { state: 'ready', message: '14-sign model' },
    ]);
  });

  it('turns recognizer events into RecognizedSigns and sentence ends', async () => {
    const { bridge, rec, signs, ends } = setup();
    await rec.start();
    bridge.send({ type: 'sign', sign: 'HELP', confidence: 0.91, candidates: [['HELP', 0.91], ['STOP', 0.05]], ts: sec(now) });
    bridge.send({ type: 'end_of_sentence', signs: ['HELP'], ts: sec(now) });
    expect(signs).toEqual([
      {
        id: `asl-${now}-HELP`,
        gloss: 'HELP',
        confidence: 0.91,
        ts: now,
        final: true,
        uncertain: false,
        alternatives: [{ gloss: 'STOP', confidence: 0.05 }],
      },
    ]);
    expect(ends).toHaveBeenCalledTimes(1);
  });

  it('never delivers the same sign twice in a session', async () => {
    const { bridge, rec, signs } = setup();
    await rec.start();
    const msg = { type: 'sign', sign: 'NO', confidence: 0.8, ts: sec(now) };
    bridge.send(msg);
    bridge.send(msg);
    expect(signs).toHaveLength(1);
  });

  it('stop disconnects and ignores anything that arrives afterwards; start works again', async () => {
    const { bridge, rec, signs, statuses } = setup();
    await rec.start();
    rec.stop();
    expect(bridge.stop).toHaveBeenCalled();
    expect(bridge.listening).toBe(false);
    expect(statuses.at(-1)).toEqual({ state: 'idle' });
    bridge.send({ type: 'sign', sign: 'YES', confidence: 0.9, ts: sec(now) });
    expect(signs).toHaveLength(0);
    rec.stop(); // idempotent
    await rec.start();
    bridge.send({ type: 'sign', sign: 'YES', confidence: 0.9, ts: sec(now) });
    expect(signs).toHaveLength(1);
  });

  it('passes the main process’s explanation through when it can’t connect', async () => {
    const { bridge, rec, statuses } = setup();
    bridge.startResult = { state: 'connecting', message: 'Waiting for the SignFlow ASL recognizer on ws://127.0.0.1:8765.' };
    await rec.start();
    expect(statuses.at(-1)).toEqual({ state: 'connecting', message: 'Waiting for the SignFlow ASL recognizer on ws://127.0.0.1:8765.' });
    bridge.setStatus({ state: 'ready', model: 'keyword116' });
    expect(statuses.at(-1)).toEqual({ state: 'ready', message: '116-sign keyword model' });
  });

  it('a failed start shows an error instead of throwing', async () => {
    const { bridge, rec, statuses } = setup();
    bridge.start.mockRejectedValueOnce(new Error('Blocked IPC'));
    await rec.start();
    expect(statuses.at(-1)).toEqual({ state: 'error', message: 'Blocked IPC' });
  });
});
