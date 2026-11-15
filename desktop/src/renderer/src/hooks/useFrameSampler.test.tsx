import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFrameSampler } from './useFrameSampler';
import { FakeRecognizer } from '../test/fakes';
import type { SignRecognizer } from '../adapters/types';

/** A <video> that looks like it is showing a live 640×480 camera stream. */
function liveVideo(stream: { active?: boolean } | null = { active: true }): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperties(video, {
    readyState: { value: 4 },
    videoWidth: { value: 640 },
    videoHeight: { value: 480 },
    srcObject: { value: stream, writable: true },
  });
  return video;
}

/** FakeRecognizer that asks for JPEG-encoded frames. */
function jpegRecognizer(): FakeRecognizer {
  const r = new FakeRecognizer();
  Object.defineProperty(r, 'frameFormat', { value: 'jpeg' });
  return r;
}

describe('useFrameSampler', () => {
  let encodes: ((blob: Blob | null) => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
    encodes = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => void encodes.push(cb));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function sample(recognizer: SignRecognizer, video: HTMLVideoElement, active = true) {
    return renderHook(({ on }) => useFrameSampler({ current: video }, recognizer, on, { fps: 10 }), { initialProps: { on: active } });
  }

  it('pushes metadata frames at the given rate while active', () => {
    const recognizer = new FakeRecognizer();
    const { rerender } = sample(recognizer, liveVideo());
    vi.advanceTimersByTime(350);
    expect(recognizer.frames).toHaveLength(3);
    expect(recognizer.frames[0]).toMatchObject({ width: 640, height: 480 });
    rerender({ on: false });
    vi.advanceTimersByTime(500);
    expect(recognizer.frames).toHaveLength(3);
  });

  it('drops a JPEG that finishes encoding after the camera stopped', () => {
    const recognizer = jpegRecognizer();
    const { rerender } = sample(recognizer, liveVideo());
    vi.advanceTimersByTime(100);
    expect(encodes).toHaveLength(1);
    rerender({ on: false }); // camera stopped while the frame was encoding
    encodes[0]!(new Blob(['jpeg']));
    expect(recognizer.frames).toHaveLength(0);
  });

  it('drops a JPEG that finishes encoding after unmount', () => {
    const recognizer = jpegRecognizer();
    const { unmount } = sample(recognizer, liveVideo());
    vi.advanceTimersByTime(100);
    unmount();
    encodes[0]!(new Blob(['jpeg']));
    expect(recognizer.frames).toHaveLength(0);
  });

  it('a stale encode does not block the next run after a restart', () => {
    const recognizer = jpegRecognizer();
    const { rerender } = sample(recognizer, liveVideo());
    vi.advanceTimersByTime(100);
    rerender({ on: false });
    rerender({ on: true }); // the first encode never came back
    vi.advanceTimersByTime(100);
    expect(encodes).toHaveLength(2);
    encodes[1]!(new Blob(['jpeg']));
    expect(recognizer.frames).toHaveLength(1);
    expect(recognizer.frames[0]!.jpeg).toBeInstanceOf(Blob);
  });

  it('never samples a video whose stream has ended or been detached', () => {
    const recognizer = new FakeRecognizer();
    sample(recognizer, liveVideo({ active: false }));
    vi.advanceTimersByTime(300);
    expect(recognizer.frames).toHaveLength(0);

    const other = new FakeRecognizer();
    sample(other, liveVideo(null));
    vi.advanceTimersByTime(300);
    expect(other.frames).toHaveLength(0);
  });
});
