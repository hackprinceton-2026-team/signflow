import { useEffect, useRef, type RefObject } from 'react';

interface Props {
  stream: MediaStream | null;
  mirrored?: boolean;
  className?: string;
  label?: string;
  /** Pass a ref to read frames from this element (e.g. the frame sampler). */
  videoRef?: RefObject<HTMLVideoElement | null>;
  hidden?: boolean;
  testId?: string;
}

/** A <video> bound to a MediaStream. Several can show the same stream. */
export function CameraView({ stream, mirrored, className = '', label = 'Camera preview', videoRef, hidden, testId }: Props) {
  const ownRef = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? ownRef;

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) video.play().catch(() => undefined);
  }, [ref, stream]);

  return (
    <video
      ref={ref}
      className={`camera-view ${mirrored ? 'is-mirrored' : ''} ${className}`}
      muted
      playsInline
      autoPlay
      aria-label={hidden ? undefined : label}
      aria-hidden={hidden ? true : undefined}
      tabIndex={-1}
      data-testid={testId}
    />
  );
}
