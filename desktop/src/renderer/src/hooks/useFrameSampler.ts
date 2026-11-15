import { useEffect, useRef, type RefObject } from 'react';
import type { SignRecognizer } from '../adapters/types';

export interface FrameSamplerOptions {
  fps?: number;
  /** Longest edge of encoded frames; smaller = less bandwidth to the backend. */
  maxEdge?: number;
  jpegQuality?: number;
}

/**
 * Samples the <video> at `fps` and hands frames to the recognizer.
 * Frames are JPEG-encoded only if the recognizer asks for them.
 */
export function useFrameSampler(
  videoRef: RefObject<HTMLVideoElement | null>,
  recognizer: SignRecognizer,
  active: boolean,
  { fps = 10, maxEdge = 640, jpegQuality = 0.7 }: FrameSamplerOptions = {},
): void {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const encoding = useRef(false);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(
      () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth) return;
        const ts = Date.now();
        const { videoWidth: vw, videoHeight: vh } = video;

        if (recognizer.frameFormat !== 'jpeg') {
          recognizer.pushFrame({ ts, width: vw, height: vh });
          return;
        }
        if (encoding.current) return; // drop frames rather than queue them

        const scale = Math.min(1, maxEdge / Math.max(vw, vh));
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);
        const canvas = (canvasRef.current ??= document.createElement('canvas'));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        encoding.current = true;
        canvas.toBlob(
          (blob) => {
            encoding.current = false;
            if (blob) recognizer.pushFrame({ ts, width: w, height: h, jpeg: blob });
          },
          'image/jpeg',
          jpegQuality,
        );
      },
      Math.max(1, Math.round(1000 / fps)),
    );
    return () => clearInterval(interval);
  }, [active, fps, jpegQuality, maxEdge, recognizer, videoRef]);
}
