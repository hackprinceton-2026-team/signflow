import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBackendHealth } from './useBackendHealth';
import { createFakeBackend } from '../test/fakeBackend';

describe('useBackendHealth', () => {
  it('is disabled (and makes no requests) in demo mode', async () => {
    const backend = createFakeBackend();
    const { result } = renderHook(() => useBackendHealth(backend.client, false));
    await act(async () => undefined);
    expect(result.current.status).toBe('disabled');
    expect(backend.calls).toHaveLength(0);
  });

  it('checks on enable: online, degraded, offline', async () => {
    const backend = createFakeBackend();
    const { result } = renderHook(() => useBackendHealth(backend.client, true));
    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('online'));
    expect(result.current.health?.model).toBe('gemini-test');

    backend.state.translationConfigured = false;
    await act(() => result.current.check());
    expect(result.current.status).toBe('degraded');

    backend.state.offline = true;
    await act(() => result.current.check());
    expect(result.current.status).toBe('offline');
    expect(result.current.error).toMatch(/Can't reach/);
  });

  it('re-checks when the network comes back', async () => {
    const backend = createFakeBackend({ offline: true });
    const { result } = renderHook(() => useBackendHealth(backend.client, true));
    await waitFor(() => expect(result.current.status).toBe('offline'));
    backend.state.offline = false;
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(result.current.status).toBe('online'));
  });

  it('polls while enabled and resets when disabled', async () => {
    const backend = createFakeBackend();
    const { result, rerender } = renderHook(({ on }) => useBackendHealth(backend.client, on, 50), { initialProps: { on: true } });
    await waitFor(() => expect(backend.callsTo('/health').length).toBeGreaterThanOrEqual(2));
    rerender({ on: false });
    expect(result.current.status).toBe('disabled');
  });
});
