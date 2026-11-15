import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSentenceComposer, useSpeechQueue, type SentenceItem } from './useRealtime';
import { MockSpeechEngine } from '../adapters/speech';
import { SENTENCE_FALLBACK_MS, SENTENCE_SLOW_MS, WORDS_QUEUE_MAX } from '../state/realtime';
import type { EnglishDraft, RecognizedSign, Translator } from '../adapters/types';

const sign = (gloss: string, id = gloss): RecognizedSign => ({ id, gloss, confidence: 0.9, ts: Date.now(), final: true });

/** A Gemini stand-in whose answers the test releases by hand. */
class ManualGemini implements Translator {
  readonly name = 'Gemini (fake)';
  readonly source = 'ai' as const;
  readonly calls: { glosses: string[]; signal?: AbortSignal; resolve: (t: string) => void; reject: (e: Error) => void }[] = [];
  translate(signs: readonly RecognizedSign[], { signal }: { signal?: AbortSignal } = {}): Promise<EnglishDraft> {
    return new Promise((resolve, reject) => {
      const glosses = signs.map((s) => s.gloss);
      this.calls.push({
        glosses,
        signal,
        resolve: (text) => resolve({ id: 'd', text, signIds: signs.map((s) => s.id), glosses, confidence: 0.9, createdAt: 0, source: 'ai' }),
        reject,
      });
    });
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useSpeechQueue', () => {
  function setup() {
    const engine = new MockSpeechEngine(10);
    const started: string[] = [];
    const hook = renderHook(() =>
      useSpeechQueue({
        engine,
        speak: (text) => engine.speak(text, { rate: 1, pitch: 1, volume: 1 }),
        stopSpeech: () => engine.cancel(),
        available: true,
        onStart: (item) => started.push(item.text),
      }),
    );
    return { engine, started, ...hook };
  }
  const word = (text: string, t0 = Date.now()) => ({ id: `${text}-${Math.random()}`, text, kind: 'word' as const, t0 });

  it('speaks in order; words that pile up go together; measures sign → audio latency', async () => {
    const { engine, result } = setup();
    const t0 = Date.now() - 250; // the sign ended 250 ms ago
    act(() => result.current.enqueue([word('help', t0)]));
    expect(engine.spoken.map((s) => s.text)).toEqual(['help']);
    expect(result.current.last?.latencyMs).toBe(250);
    act(() => result.current.enqueue([word('doctor'), word('please')]));
    expect(engine.spoken).toHaveLength(1); // still speaking "help"
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(engine.spoken.map((s) => s.text)).toEqual(['help', 'doctor please']);
  });

  it('a sentence is never merged with words', async () => {
    const { engine, result } = setup();
    act(() => result.current.enqueue([word('hi'), { id: 's', text: 'I need a doctor.', kind: 'sentence', t0: Date.now() }, word('thanks')]));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(engine.spoken.map((s) => s.text)).toEqual(['hi', 'I need a doctor.', 'thanks']);
  });

  it('is bounded: beyond the limit the oldest waiting words are dropped (and counted)', () => {
    const { result } = setup();
    act(() => result.current.enqueue([word('first')]));
    act(() => result.current.enqueue(Array.from({ length: WORDS_QUEUE_MAX + 3 }, (_, i) => word(`w${i}`))));
    expect(result.current.queued).toHaveLength(WORDS_QUEUE_MAX);
    expect(result.current.queued[0]!.text).toBe('w3');
    expect(result.current.dropped).toBe(3);
  });

  it('stop silences the voice and empties the queue', async () => {
    const { engine, result } = setup();
    act(() => result.current.enqueue([word('one'), { id: 's', text: 'Two.', kind: 'sentence', t0: Date.now() }]));
    act(() => result.current.stop());
    expect(result.current.current).toBeNull();
    expect(result.current.queued).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(engine.spoken.map((s) => s.text)).toEqual(['one']);
  });
});

describe('useSentenceComposer (Sentence mode: Gemini composes, spoken automatically)', () => {
  function setup() {
    const gemini = new ManualGemini();
    const delivered: { text: string; item: SentenceItem }[] = [];
    const onGeminiError = vi.fn();
    const hook = renderHook(() =>
      useSentenceComposer({ translator: gemini, deliver: (item, text) => delivered.push({ item, text }), onGeminiError }),
    );
    return { gemini, delivered, onGeminiError, ...hook };
  }
  const latest = (r: { current: { items: SentenceItem[] } }) => r.current.items[0]!;

  it('Gemini composes the sentence from the signed glosses, and a faithful answer is spoken', async () => {
    const { gemini, delivered, result } = setup();
    act(() => result.current.submit([sign('I'), sign('ALLERGIC'), sign('PENICILLIN')]));
    expect(gemini.calls.map((c) => c.glosses)).toEqual([['I', 'ALLERGIC', 'PENICILLIN']]);
    expect(latest(result)).toMatchObject({ status: 'composing', localText: 'I allergic penicillin.' });
    await act(async () => gemini.calls[0]!.resolve('I am allergic to penicillin.'));
    expect(delivered.map((d) => d.text)).toEqual(['I am allergic to penicillin.']);
    expect(latest(result)).toMatchObject({ status: 'spoken', source: 'gemini', text: 'I am allergic to penicillin.' });
  });

  it('a Gemini sentence that changes a detail is held for review, never auto-spoken', async () => {
    const { gemini, delivered, result } = setup();
    act(() => result.current.submit([sign('TAKE'), sign('MEDICINE'), sign('TWO')]));
    await act(async () => gemini.calls[0]!.resolve('Take three pills of your medicine.'));
    expect(delivered).toHaveLength(0);
    expect(latest(result)).toMatchObject({ status: 'review', geminiText: 'Take three pills of your medicine.' });
    act(() => result.current.resolveReview(latest(result).id, 'local'));
    expect(delivered.map((d) => d.text)).toEqual(['Take medicine two.']);
  });

  it('API error: the local composition is spoken at once, clearly labelled', async () => {
    const { gemini, delivered, onGeminiError, result } = setup();
    act(() => result.current.submit([sign('HELP'), sign('DOCTOR')]));
    await act(async () => gemini.calls[0]!.reject(new Error('Gemini rejected the API key.')));
    expect(delivered.map((d) => d.text)).toEqual(['Help doctor.']);
    expect(latest(result)).toMatchObject({ source: 'local-fallback', reason: 'Gemini unavailable: Gemini rejected the API key.' });
    expect(onGeminiError).toHaveBeenCalled();
  });

  it('slow Gemini: marked slow, then after the fallback time the local sentence is spoken and the late answer dropped', async () => {
    const { gemini, delivered, result } = setup();
    act(() => result.current.submit([sign('HELP')]));
    await act(() => vi.advanceTimersByTimeAsync(SENTENCE_SLOW_MS));
    expect(latest(result).slow).toBe(true);
    expect(delivered).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(SENTENCE_FALLBACK_MS - SENTENCE_SLOW_MS));
    expect(delivered.map((d) => d.text)).toEqual(['Help.']);
    expect(gemini.calls[0]!.signal?.aborted).toBe(true);
    await act(async () => gemini.calls[0]!.resolve('I need help.'));
    expect(delivered).toHaveLength(1); // the late Gemini answer is never spoken
  });

  it('a Gemini answer that arrives just before the fallback time is used', async () => {
    const { gemini, delivered, result } = setup();
    act(() => result.current.submit([sign('HELP')]));
    await act(() => vi.advanceTimersByTimeAsync(SENTENCE_FALLBACK_MS - 50));
    await act(async () => gemini.calls[0]!.resolve('I need help.'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(delivered.map((d) => d.text)).toEqual(['I need help.']);
  });

  it('Speak now: the local sentence is spoken right away; Gemini’s later answer is discarded', async () => {
    const { gemini, delivered, result } = setup();
    act(() => result.current.submit([sign('WATER')]));
    act(() => result.current.speakNow(latest(result).id));
    expect(delivered.map((d) => d.text)).toEqual(['Water.']);
    expect(latest(result).source).toBe('local');
    await act(async () => gemini.calls[0]!.resolve('Could I have some water?'));
    expect(delivered).toHaveLength(1);
  });

  it('Stop / mode switch / recognition restart (reset): a pending Gemini answer never plays', async () => {
    const { gemini, delivered, result } = setup();
    act(() => result.current.submit([sign('HELLO')]));
    act(() => result.current.submit([sign('BYE')])); // waiting behind the first
    act(() => result.current.reset());
    expect(latest(result).status).toBe('stopped');
    await act(async () => gemini.calls[0]!.resolve('Hello.'));
    await act(() => vi.advanceTimersByTimeAsync(SENTENCE_FALLBACK_MS + 1000));
    expect(delivered).toHaveLength(0);
    expect(gemini.calls).toHaveLength(1); // the queued sentence was dropped too
  });

  it('sentences are composed one at a time, in order', async () => {
    const { gemini, delivered, result } = setup();
    act(() => result.current.submit([sign('HELLO')]));
    act(() => result.current.submit([sign('THANK-YOU')]));
    expect(gemini.calls).toHaveLength(1);
    await act(async () => gemini.calls[0]!.resolve('Hello.'));
    expect(gemini.calls).toHaveLength(2);
    await act(async () => gemini.calls[1]!.resolve('Thank you.'));
    expect(delivered.map((d) => d.text)).toEqual(['Hello.', 'Thank you.']);
  });
});
