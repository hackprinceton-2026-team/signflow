import { useCallback, useState } from 'react';

/**
 * useState backed by localStorage. Storage errors (quota, privacy mode) are
 * swallowed so the UI always works; `validate` guards against stale shapes.
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  validate: (value: unknown) => value is T = (_v): _v is T => true,
) {
  const [value, setValue] = useState<T>(() => {
    const fallback = () => (typeof initial === 'function' ? (initial as () => T)() : initial);
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback();
      const parsed: unknown = JSON.parse(raw);
      return validate(parsed) ? parsed : fallback();
    } catch {
      return fallback();
    }
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* storage unavailable: keep in-memory value */
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set] as const;
}
