import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSignSession } from './useSignSession';
import { FakeRecognizer } from '../test/fakes';
import { MockTranslator } from '../adapters/mock/mockTranslator';

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
      expect.objectContaining({ autoSpeak: true }),
    );
    expect(result.current.state.transcript).toHaveLength(1);
    expect(result.current.state.draft).toBeNull();
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
