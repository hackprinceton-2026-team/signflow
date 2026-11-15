import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendClient } from '../adapters/remote/backendClient';
import { BackendError } from '../adapters/remote/backendClient';
import type { HealthResponse } from '../adapters/remote/guards';

/**
 * - `disabled`: demo mode, the backend isn't used
 * - `checking`: first check in progress
 * - `online`: reachable and translation is configured
 * - `degraded`: reachable, but translation isn't configured (no API key)
 * - `offline`: unreachable, or it answered with an error
 */
export type BackendStatus = 'disabled' | 'checking' | 'online' | 'degraded' | 'offline';

interface HealthResult {
  status: Exclude<BackendStatus, 'disabled' | 'checking'>;
  health: HealthResponse | null;
  error: string | null;
  checkedAt: number;
}

export const HEALTH_POLL_MS = 15_000;

/** Polls `/health` while live mode is on, and re-checks when the network comes back. */
export function useBackendHealth(client: BackendClient, enabled: boolean, pollMs = HEALTH_POLL_MS) {
  const [result, setResult] = useState<HealthResult | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const check = useCallback(async (): Promise<void> => {
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    try {
      const health = await client.health({ signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setResult({ status: health.translation === 'ready' ? 'online' : 'degraded', health, error: null, checkedAt: Date.now() });
    } catch (err) {
      if (ctrl.signal.aborted || (err instanceof BackendError && err.kind === 'aborted')) return;
      setResult({ status: 'offline', health: null, error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() });
    }
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(() => void check(), 0);
    const timer = setInterval(() => void check(), pollMs);
    const recheck = () => void check();
    window.addEventListener('online', recheck);
    window.addEventListener('offline', recheck);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener('online', recheck);
      window.removeEventListener('offline', recheck);
      inFlight.current?.abort();
      setResult(null);
    };
  }, [check, enabled, pollMs]);

  return {
    status: (enabled ? (result?.status ?? 'checking') : 'disabled') as BackendStatus,
    health: enabled ? (result?.health ?? null) : null,
    error: enabled ? (result?.error ?? null) : null,
    check,
  };
}

export type BackendHealth = ReturnType<typeof useBackendHealth>;
