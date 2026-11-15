import { useCallback, useEffect, useState } from 'react';
import { isKokoroStatus, type KokoroStatus } from '@shared/kokoro';
import type { KokoroBridge } from '../adapters/kokoroSpeech';

export interface KokoroController {
  /** null until the main process has answered. */
  status: KokoroStatus | null;
  /** Load the model now (and re-check the install). */
  prepare: () => Promise<void>;
}

/**
 * Tracks the Kokoro engine's status. While `active` (Kokoro is the selected
 * engine), the model is loaded in the background right away, so the first
 * confirmed sentence doesn't wait for it.
 */
export function useKokoro(bridge: KokoroBridge | undefined, active: boolean): KokoroController {
  const [status, setStatus] = useState<KokoroStatus | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const accept = (s: unknown) => {
      if (alive && isKokoroStatus(s)) setStatus(s);
    };
    const off = bridge.onStatus(accept);
    // Selecting Kokoro loads the model in the background (status events report progress).
    (active ? bridge.prepare() : bridge.status()).then(accept, () => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [bridge, active]);

  const prepare = useCallback(async () => {
    if (!bridge) return;
    try {
      const s = await bridge.prepare();
      if (isKokoroStatus(s)) setStatus(s);
    } catch {
      /* the status event carries the error */
    }
  }, [bridge]);

  return { status, prepare };
}
