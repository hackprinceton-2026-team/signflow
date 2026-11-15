import { useEffect, useState } from 'react';
import type { RecognizerPreview } from '@shared/recognizer';
import type { RecognizerBridge } from '../adapters/external/aslRecognizer';

/** No frame for this long: the preview is gone (recognizer stopped, or plain live.py without previews). */
export const PREVIEW_STALE_MS = 2000;

/**
 * The newest camera preview frame from the local recognizer, as an <img> source, while
 * `active`. Frames are validated and throttled by the main process; the camera itself
 * is only ever opened by the recognizer process. null when no frames are arriving.
 */
export function useRecognizerPreview(bridge: RecognizerBridge | undefined, active: boolean) {
  const [frame, setFrame] = useState<(RecognizerPreview & { src: string }) | null>(null);

  useEffect(() => {
    if (!bridge || !active) return;
    let stale: ReturnType<typeof setTimeout> | null = null;
    const off = bridge.onPreview((f) => {
      setFrame({ ...f, src: `data:image/jpeg;base64,${f.jpeg}` });
      if (stale) clearTimeout(stale);
      stale = setTimeout(() => setFrame(null), PREVIEW_STALE_MS);
    });
    return () => {
      off();
      if (stale) clearTimeout(stale);
      setFrame(null);
    };
  }, [active, bridge]);

  return active ? frame : null;
}
