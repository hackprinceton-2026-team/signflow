import { useEffect, useState } from 'react';

/**
 * True after `ms` without pointer movement or key presses (only while `enabled`).
 * Used to fade Focus Mode controls like a video player.
 */
export function useIdle(enabled: boolean, ms = 2500): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let timer = setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
      setIdle(false);
    };
  }, [enabled, ms]);

  return enabled && idle;
}
