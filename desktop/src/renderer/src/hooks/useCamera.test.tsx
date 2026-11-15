import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describeCameraError, useCamera } from './useCamera';
import { installFakeBridge } from '../test/setup';
import { FakeMediaStream, installFakeMediaDevices } from '../test/fakes';

describe('describeCameraError', () => {
  it.each([
    ['NotAllowedError', 'permission'],
    ['NotFoundError', 'no-device'],
    ['NotReadableError', 'in-use'],
    ['Weird', 'unknown'],
  ])('%s -> %s', (name, kind) => {
    expect(describeCameraError(new DOMException('x', name)).kind).toBe(kind);
  });
});

describe('useCamera', () => {
  it('starts the camera, lists devices, and stops tracks on stop()', async () => {
    installFakeBridge();
    const { getUserMedia, streams } = installFakeMediaDevices();
    const { result } = renderHook(() => useCamera());

    await waitFor(() => expect(result.current.devices).toHaveLength(2));
    await act(() => result.current.start());

    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    expect(result.current.status).toBe('on');
    expect(result.current.deviceId).toBe('cam-1');

    act(() => result.current.stop());
    expect(result.current.status).toBe('off');
    expect(streams[0]?.track.stop).toHaveBeenCalled();
  });

  it('reports a permission error when the OS denies access', async () => {
    installFakeBridge({
      camera: { accessStatus: async () => 'denied', requestAccess: async () => 'denied' },
    });
    const { getUserMedia } = installFakeMediaDevices();
    const { result } = renderHook(() => useCamera());

    await act(() => result.current.start());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
    expect(result.current.error?.kind).toBe('permission');
  });

  it('reports a busy camera from getUserMedia', async () => {
    installFakeBridge();
    installFakeMediaDevices({
      getUserMedia: async () => {
        throw new DOMException('busy', 'NotReadableError');
      },
    });
    const { result } = renderHook(() => useCamera());
    await act(() => result.current.start());
    expect(result.current.error?.kind).toBe('in-use');
  });

  it('flags an error if the camera track ends unexpectedly', async () => {
    installFakeBridge();
    const { streams } = installFakeMediaDevices();
    const { result } = renderHook(() => useCamera());
    await act(() => result.current.start());
    act(() => streams[0]?.track.fire('ended'));
    expect(result.current.status).toBe('error');
  });

  it('releases the camera on unmount', async () => {
    installFakeBridge();
    const { streams } = installFakeMediaDevices();
    const { result, unmount } = renderHook(() => useCamera());
    await act(() => result.current.start());
    unmount();
    expect(streams[0]?.track.stop).toHaveBeenCalled();
  });

  it('releases a camera that finishes starting after unmount (no camera left on)', async () => {
    installFakeBridge();
    let finish: (s: FakeMediaStream) => void = () => undefined;
    const { getUserMedia } = installFakeMediaDevices({ getUserMedia: () => new Promise((r) => (finish = r)) });
    const { result, unmount } = renderHook(() => useCamera());
    let pending: Promise<void> = Promise.resolve();
    act(() => void (pending = result.current.start()));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    unmount();
    const late = new FakeMediaStream();
    finish(late);
    await pending;
    expect(late.track.stop).toHaveBeenCalled();
  });

  it('stopping during the OS permission prompt never opens the camera', async () => {
    let grant: (v: 'granted') => void = () => undefined;
    installFakeBridge({ camera: { accessStatus: async () => 'not-determined', requestAccess: () => new Promise((r) => (grant = r)) } });
    const { getUserMedia } = installFakeMediaDevices();
    const { result } = renderHook(() => useCamera());
    let pending: Promise<void> = Promise.resolve();
    act(() => void (pending = result.current.start()));
    act(() => result.current.stop());
    await act(async () => {
      grant('granted');
      await pending;
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.status).toBe('off');
    expect(vi.isMockFunction(getUserMedia)).toBe(true);
  });
});

