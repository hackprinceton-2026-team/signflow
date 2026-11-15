import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_CAPTION_SETTINGS } from '@shared/captions';
import { buildCaptionPayload, useCaptions } from './useCaptions';
import { initialSessionState, type SessionState } from '../state/session';
import { installFakeBridge } from '../test/setup';

const utter = (id: string, text: string) => ({ id, text, glosses: [], confidence: 0.9, confirmedAt: 0, edited: false });
const sign = (id: string, gloss: string) => ({ id, gloss, confidence: 0.9, ts: 0, final: true });

describe('buildCaptionPayload', () => {
  it('shows the last N confirmed lines', () => {
    const state = { ...initialSessionState(), transcript: [utter('1', 'A.'), utter('2', 'B.'), utter('3', 'C.')] };
    const p = buildCaptionPayload(state, { ...DEFAULT_CAPTION_SETTINGS, maxLines: 2 });
    expect(p.lines).toEqual([
      { id: '2', text: 'B.' },
      { id: '3', text: 'C.' },
    ]);
  });

  it('live text prefers the pending draft, else the current signs', () => {
    const withBuffer = { ...initialSessionState(), buffer: [sign('a', 'HOW'), sign('b', 'YOU')] };
    expect(buildCaptionPayload(withBuffer, DEFAULT_CAPTION_SETTINGS).live).toBe('HOW YOU …');

    const withDraft: SessionState = {
      ...withBuffer,
      draft: {
        draft: { id: 'd', text: 'How are you?', signIds: [], glosses: [], confidence: 1, createdAt: 0, source: 'demo' },
        text: ' How are you? ',
        edited: false,
      },
    };
    expect(buildCaptionPayload(withDraft, DEFAULT_CAPTION_SETTINGS).live).toBe('How are you?');
    expect(buildCaptionPayload(initialSessionState(), DEFAULT_CAPTION_SETTINGS).live).toBe('');
  });
});

describe('useCaptions', () => {
  beforeEach(() => localStorage.clear());

  it('toggles the window and streams updates only while visible', async () => {
    const bridge = installFakeBridge();
    const { result, rerender } = renderHook(({ s }) => useCaptions(s), { initialProps: { s: initialSessionState() } });
    rerender({ s: { ...initialSessionState(), transcript: [utter('1', 'Hidden.')] } });
    expect(bridge.captions.update).not.toHaveBeenCalled();

    await act(() => result.current.toggle());
    expect(bridge.captions.setVisible).toHaveBeenCalledWith(true);
    expect(result.current.visible).toBe(true);

    const next = { ...initialSessionState(), transcript: [utter('2', 'Hello.')] };
    rerender({ s: next });
    expect(bridge.captions.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ lines: [{ id: '2', text: 'Hello.' }] }),
    );

    act(() => result.current.update({ fontSize: 40 }));
    expect(bridge.captions.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ fontSize: 40 }) }),
    );
    expect(JSON.parse(localStorage.getItem('signflow.captions') ?? '{}').fontSize).toBe(40);
  });

  it('follows visibility events from main (e.g. the overlay closed itself)', () => {
    let emit: (v: boolean) => void = () => undefined;
    installFakeBridge();
    window.signflow.captions.onVisibilityChange = vi.fn((cb: (v: boolean) => void) => {
      emit = cb;
      return () => undefined;
    });
    const { result } = renderHook(() => useCaptions(initialSessionState()));
    act(() => emit(true));
    expect(result.current.visible).toBe(true);
    act(() => emit(false));
    expect(result.current.visible).toBe(false);
  });
});
