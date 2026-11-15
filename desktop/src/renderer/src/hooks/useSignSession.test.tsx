import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { SENTENCE_END_FALLBACK_MS, useSignSession } from './useSignSession';
import { Emitter } from '../adapters/emitter';
import { FakeRecognizer } from '../test/fakes';
import { MockTranslator } from '../adapters/mock/mockTranslator';
import type { EnglishDraft, RecognizedSign, Translator } from '../adapters/types';

/** A translator whose answers the test releases by hand (optionally ignoring abort, like a slow network). */
class ManualTranslator implements Translator {
  readonly calls: { glosses: string[]; signal: AbortSignal | undefined; resolve: (text: string) => void; reject: (e: Error) => void }[] = [];

  constructor(
    readonly name: string,
    readonly source: 'demo' | 'ai',
    private readonly honorAbort = true,
  ) {}

  translate(signs: readonly RecognizedSign[], { signal }: { signal?: AbortSignal } = {}): Promise<EnglishDraft> {
    return new Promise((resolve, reject) => {
      const glosses = signs.map((s) => s.gloss);
      const draft = (text: string): EnglishDraft => ({
        id: `${this.name}-${this.calls.length}`,
        text,
        signIds: signs.map((s) => s.id),
        glosses,
        confidence: 0.9,
        createdAt: 0,
        source: this.source,
      });
      this.calls.push({ glosses, signal, resolve: (text) => resolve(draft(text)), reject });
      if (this.honorAbort) signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }
}

describe('useSignSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(opts: { active?: boolean; failWith?: string } = {}) {
    const recognizer = new FakeRecognizer();
    const translator = new MockTranslator({ latencyMs: 50, ...(opts.failWith ? { failWith: opts.failWith } : {}) });
    const onConfirm = vi.fn();
    const hook = renderHook(
      ({ active }) => useSignSession({ recognizer, translator }, { active, onConfirm, initialSettings: { pauseMs: 1000 } }),
      { initialProps: { active: opts.active ?? true } },
    );
    return { recognizer, onConfirm, ...hook };
  }

  it('starts and stops the recognizer with `active`', async () => {
    const { recognizer, rerender, result } = setup({ active: false });
    expect(recognizer.start).not.toHaveBeenCalled();
    rerender({ active: true });
    await act(async () => undefined);
    expect(recognizer.start).toHaveBeenCalledTimes(1);
    expect(result.current.recognizerStatus.state).toBe('ready');
    rerender({ active: false });
    expect(recognizer.stop).toHaveBeenCalled();
  });

  it('turns a phrase into a draft after the pause, ignoring low-confidence signs', async () => {
    const { recognizer, result } = setup();
    act(() => {
      recognizer.emit('HOW', 0.9);
      recognizer.emit('UM', 0.3);
      recognizer.emit('YOU', 0.88);
    });
    expect(result.current.state.buffer.map((s) => s.gloss)).toEqual(['HOW', 'YOU']);
    expect(result.current.state.liveSigns).toHaveLength(3);

    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(result.current.state.draft).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1 + 50));
    expect(result.current.state.draft?.text).toBe('How are you?');
    expect(result.current.state.buffer).toHaveLength(0);
  });

  it('each new sign restarts the pause timer', async () => {
    const { recognizer, result } = setup();
    act(() => void recognizer.emit('I'));
    await act(() => vi.advanceTimersByTimeAsync(800));
    act(() => void recognizer.emit('NEED'));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(result.current.state.draft).toBeNull();
    act(() => void recognizer.emit('HELP'));
    await act(() => vi.advanceTimersByTimeAsync(1100));
    expect(result.current.state.draft?.text).toBe('I need help.');
  });

  it('confirm() hands the utterance to onConfirm', async () => {
    const { recognizer, result, onConfirm } = setup();
    act(() => void recognizer.emit('THANK-YOU'));
    await act(() => vi.advanceTimersByTimeAsync(1100));
    act(() => result.current.editDraft('Thank you so much.'));
    act(() => result.current.confirm());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Thank you so much.', edited: true }),
      expect.objectContaining({ autoSpeak: false }),
      {},
    );
    expect(result.current.state.transcript).toHaveLength(1);
    expect(result.current.state.draft).toBeNull();
  });

  it('confirm({ speak: true }) passes the speak intent through', async () => {
    const { recognizer, result, onConfirm } = setup();
    act(() => void recognizer.emit('HELLO'));
    await act(() => vi.advanceTimersByTimeAsync(1100));
    act(() => result.current.confirm({ speak: true }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello.' }), expect.anything(), { speak: true });
  });

  it('confirm() without a draft does nothing', () => {
    const { result, onConfirm } = setup();
    act(() => result.current.confirm({ speak: true }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('translateNow() skips the pause', async () => {
    const { recognizer, result } = setup();
    act(() => void recognizer.emit('HELLO'));
    act(() => result.current.translateNow());
    await act(() => vi.advanceTimersByTimeAsync(60));
    expect(result.current.state.draft?.text).toBe('Hello.');
  });

  it('surfaces translation errors and keeps the signs for retry', async () => {
    const { recognizer, result } = setup({ failWith: 'backend unreachable' });
    act(() => void recognizer.emit('HELLO'));
    await act(() => vi.advanceTimersByTimeAsync(1100));
    expect(result.current.state.draftStatus).toBe('error');
    expect(result.current.state.draftError).toBe('backend unreachable');
    expect(result.current.state.buffer.map((s) => s.gloss)).toEqual(['HELLO']);
  });
});

describe('useSignSession: stale translations (Demo/Live or context switches)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(first: Translator) {
    const recognizer = new FakeRecognizer();
    const onConfirm = vi.fn();
    const hook = renderHook(
      ({ translator }) => useSignSession({ recognizer, translator }, { active: true, onConfirm, initialSettings: { pauseMs: 1000 } }),
      { initialProps: { translator: first } },
    );
    return { recognizer, onConfirm, ...hook };
  }

  async function signAndWait(recognizer: FakeRecognizer, glosses: string[]) {
    act(() => glosses.forEach((g) => recognizer.emit(g, 0.9)));
    await act(() => vi.advanceTimersByTimeAsync(1000));
  }

  it('switching translators aborts the in-flight request and re-drafts the same signs with the new one', async () => {
    const demo = new ManualTranslator('demo', 'demo');
    const ai = new ManualTranslator('ai', 'ai');
    const { recognizer, rerender, result } = setup(demo);
    await signAndWait(recognizer, ['HOW', 'YOU']);
    expect(demo.calls).toHaveLength(1);
    expect(result.current.state.draftStatus).toBe('translating');

    rerender({ translator: ai });
    expect(demo.calls[0]!.signal?.aborted).toBe(true);
    expect(result.current.state.draftStatus).toBe('idle');
    expect(result.current.state.buffer.map((s) => s.gloss)).toEqual(['HOW', 'YOU']); // given back, in order
    expect(result.current.translatorSource).toBe('ai');

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(ai.calls.map((c) => c.glosses)).toEqual([['HOW', 'YOU']]);
    await act(async () => ai.calls[0]!.resolve('How are you?'));
    expect(result.current.state.draft?.draft).toMatchObject({ text: 'How are you?', source: 'ai' });
  });

  it('ignores a late answer from the old translator even if it ignored the abort', async () => {
    const demo = new ManualTranslator('demo', 'demo', false);
    const ai = new ManualTranslator('ai', 'ai');
    const { recognizer, rerender, result } = setup(demo);
    await signAndWait(recognizer, ['HELLO']);
    rerender({ translator: ai });
    await act(async () => demo.calls[0]!.resolve('STALE demo text'));
    expect(result.current.state.draft).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(async () => ai.calls[0]!.resolve('Hello.'));
    // A late failure of the abandoned request doesn't surface either.
    await act(async () => demo.calls[0]!.reject(new Error('old backend down')));
    expect(result.current.state.draft?.text).toBe('Hello.');
    expect(result.current.state.draftError).toBeNull();
  });

  it('a stale error from the old translator is cleared, and its signs are drafted by the new one', async () => {
    const ai = new ManualTranslator('ai', 'ai');
    const demo = new ManualTranslator('demo', 'demo');
    const { recognizer, rerender, result } = setup(ai);
    await signAndWait(recognizer, ['HELP']);
    await act(async () => ai.calls[0]!.reject(new Error("Can't reach the SignFlow backend")));
    expect(result.current.state.draftStatus).toBe('error');

    rerender({ translator: demo });
    expect(result.current.state.draftStatus).toBe('idle');
    expect(result.current.state.draftError).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(demo.calls.map((c) => c.glosses)).toEqual([['HELP']]);
  });

  it('a new context (same kind of translator) also re-drafts with the new one', async () => {
    const chat = new ManualTranslator('ai-chat', 'ai');
    const medical = new ManualTranslator('ai-medical', 'ai');
    const { recognizer, rerender, result } = setup(chat);
    await signAndWait(recognizer, ['HEADACHE']);
    rerender({ translator: medical });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(async () => medical.calls[0]!.resolve('I have a headache.'));
    await act(async () => chat.calls[0]?.resolve('stale'));
    expect(result.current.state.draft?.text).toBe('I have a headache.');
  });

  it('re-rendering with the same translator does not cancel anything', async () => {
    const demo = new ManualTranslator('demo', 'demo');
    const { recognizer, rerender, result } = setup(demo);
    await signAndWait(recognizer, ['HI']);
    rerender({ translator: demo });
    expect(demo.calls[0]!.signal?.aborted).toBe(false);
    await act(async () => demo.calls[0]!.resolve('Hi.'));
    expect(result.current.state.draft?.text).toBe('Hi.');
  });

  it('confirming twice before React re-renders confirms (and speaks) once', async () => {
    const demo = new ManualTranslator('demo', 'demo');
    const { recognizer, result, onConfirm } = setup(demo);
    await signAndWait(recognizer, ['HI']);
    await act(async () => demo.calls[0]!.resolve('Hi.'));
    act(() => {
      result.current.confirm({ speak: true });
      result.current.confirm({ speak: true });
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(result.current.state.transcript).toHaveLength(1);
  });
});

describe('useSignSession with a recognizer that reports sentence ends (the local ASL model)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** FakeRecognizer + onSentenceEnd, like AslRecognizer. */
  class SegmentingRecognizer extends FakeRecognizer {
    readonly ends = new Emitter<void>();
    onSentenceEnd(cb: () => void) {
      return this.ends.on(cb);
    }
    endSentence() {
      this.ends.emit();
    }
  }

  function setup() {
    const recognizer = new SegmentingRecognizer();
    const translator = new ManualTranslator('asl', 'demo');
    const hook = renderHook(() => useSignSession({ recognizer, translator }, { active: true, initialSettings: { pauseMs: 1000 } }));
    return { recognizer, translator, ...hook };
  }

  it('drafts the whole sentence when it ends, not after the usual pause between slow signs', async () => {
    const { recognizer, translator, result } = setup();
    act(() => void recognizer.emit('HELP'));
    await act(() => vi.advanceTimersByTimeAsync(2500)); // a slow second sign: longer than pauseMs
    expect(translator.calls).toHaveLength(0);
    act(() => void recognizer.emit('DOCTOR'));
    act(() => recognizer.endSentence());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(translator.calls.map((c) => c.glosses)).toEqual([['HELP', 'DOCTOR']]);
    act(() => translator.calls[0]!.resolve('I need a doctor.'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.state.draft?.text).toBe('I need a doctor.');
  });

  it('a sentence end with nothing accepted is ignored: the next sign waits for its own sentence end', async () => {
    const { recognizer, translator } = setup();
    act(() => void recognizer.emit('HELP', 0.4)); // below threshold: shown, not used
    act(() => recognizer.endSentence());
    act(() => void recognizer.emit('YES'));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(translator.calls).toHaveLength(0);
    act(() => recognizer.endSentence());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(translator.calls.map((c) => c.glosses)).toEqual([['YES']]);
  });

  it('signs that arrive while a sentence is translating are drafted as soon as it finishes, if their sentence ended', async () => {
    const { recognizer, translator } = setup();
    act(() => void recognizer.emit('HELLO'));
    act(() => recognizer.endSentence());
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => void recognizer.emit('THANK-YOU'));
    act(() => recognizer.endSentence());
    expect(translator.calls).toHaveLength(1);
    await act(async () => translator.calls[0]!.resolve('Hello.'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(translator.calls.map((c) => c.glosses)).toEqual([['HELLO'], ['THANK-YOU']]);
  });

  it('falls back to drafting after SENTENCE_END_FALLBACK_MS if no sentence end ever comes', async () => {
    const { recognizer, translator } = setup();
    act(() => void recognizer.emit('WATER'));
    await act(() => vi.advanceTimersByTimeAsync(SENTENCE_END_FALLBACK_MS - 1));
    expect(translator.calls).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(translator.calls.map((c) => c.glosses)).toEqual([['WATER']]);
  });

  it('a sign the model was unsure about is shown but never drafted, even at high confidence', async () => {
    const { recognizer, translator, result } = setup();
    act(() => void recognizer.emit('SICK', 0.95, { uncertain: true }));
    act(() => recognizer.endSentence());
    await act(() => vi.advanceTimersByTimeAsync(SENTENCE_END_FALLBACK_MS + 10));
    expect(result.current.state.liveSigns).toHaveLength(1);
    expect(result.current.state.buffer).toHaveLength(0);
    expect(translator.calls).toHaveLength(0);
  });
});

describe('sentence end right after its last sign (before React renders it)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('still ends the sentence: no 6 s fallback wait', async () => {
    class SegmentingRecognizer extends FakeRecognizer {
      readonly ends = new Emitter<void>();
      onSentenceEnd(cb: () => void) {
        return this.ends.on(cb);
      }
    }
    const recognizer = new SegmentingRecognizer();
    const translator = new ManualTranslator('asl', 'demo');
    renderHook(() => useSignSession({ recognizer, translator }, { active: true, initialSettings: { pauseMs: 1000 } }));
    act(() => {
      recognizer.emit('THANK-YOU'); // the same tick: no render in between
      recognizer.ends.emit();
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(translator.calls.map((c) => c.glosses)).toEqual([['THANK-YOU']]);
  });
});
