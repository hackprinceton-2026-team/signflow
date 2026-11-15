import { useEffect, useRef } from 'react';
import { shortcutFor, type ShortcutId } from './shortcuts';

/** Global keyboard shortcuts. Handlers may return false to let the event through. */
export function useHotkeys(handlers: Partial<Record<ShortcutId, () => boolean | void>>): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const id = shortcutFor(e);
      if (!id) return;
      const handler = ref.current[id];
      if (!handler) return;
      if (handler() === false) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
