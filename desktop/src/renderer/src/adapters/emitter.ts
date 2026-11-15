import type { Unsubscribe } from './types';

/** Minimal typed listener set used by the adapters. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  on(cb: (value: T) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(value: T): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(value);
      } catch (err) {
        console.error('[signflow] listener threw', err);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

/** Small deterministic PRNG (mulberry32) so mock output is reproducible in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newId(): string {
  return crypto.randomUUID();
}
