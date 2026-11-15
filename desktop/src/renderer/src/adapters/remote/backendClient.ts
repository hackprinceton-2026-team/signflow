/**
 * Typed HTTP client for the SignFlow backend (backend/openapi.json).
 *
 * Every failure becomes a `BackendError` with a `kind` the UI can act on and a
 * message that is safe to show. Responses are validated before use.
 */
import { BACKEND_ORIGINS } from '@shared/csp';
import {
  isErrorResponse,
  isHealthResponse,
  isSpeechResponse,
  isTranslationResponse,
  type HealthResponse,
  type SpeechRequest,
  type SpeechResponse,
  type TranslationRequest,
  type TranslationResponse,
} from './guards';

/** The renderer's CSP only allows this backend origin (src/shared/csp.ts). */
export const BACKEND_URL = BACKEND_ORIGINS[0];

export type BackendErrorKind =
  | 'offline'
  | 'timeout'
  | 'not_configured'
  | 'rejected'
  | 'upstream'
  | 'server'
  | 'invalid_response'
  | 'aborted';

export class BackendError extends Error {
  override readonly name = 'BackendError';

  constructor(
    readonly kind: BackendErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

export interface BackendClient {
  readonly baseUrl: string;
  health(opts?: RequestOptions): Promise<HealthResponse>;
  translate(body: TranslationRequest, opts?: RequestOptions): Promise<TranslationResponse>;
  speak(body: SpeechRequest, opts?: RequestOptions): Promise<SpeechResponse>;
}

export interface BackendClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_SERVER_MESSAGE = 300;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function errorFromResponse(status: number, data: unknown): BackendError {
  const server = isErrorResponse(data) ? data.error : undefined;
  const message = server?.message.slice(0, MAX_SERVER_MESSAGE);
  const code = server?.code;
  if (status === 503) return new BackendError('not_configured', message ?? 'The SignFlow backend is not fully configured.', status, code);
  if (status === 400 || status === 422) {
    return new BackendError('rejected', message ? `The backend rejected the request: ${message}` : 'The backend rejected the request.', status, code);
  }
  if (status === 502 || status === 504) return new BackendError('upstream', message ?? 'The AI service failed to respond. Try again.', status, code);
  return new BackendError('server', 'The SignFlow backend had an unexpected error.', status, code);
}

export function createBackendClient(options: BackendClientOptions = {}): BackendClient {
  const baseUrl = (options.baseUrl ?? BACKEND_URL).replace(/\/+$/, '');
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const defaultTimeout = options.timeoutMs ?? 20_000;

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    guard: (v: unknown) => v is T,
    { signal, timeoutMs = defaultTimeout }: RequestOptions = {},
  ): Promise<T> {
    if (signal?.aborted) throw new BackendError('aborted', 'Request cancelled.');
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          method,
          headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'omit',
        });
      } catch {
        if (timedOut) throw new BackendError('timeout', 'The SignFlow backend took too long to respond.');
        if (signal?.aborted) throw new BackendError('aborted', 'Request cancelled.');
        throw new BackendError('offline', `Can't reach the SignFlow backend at ${hostOf(baseUrl)}. Make sure it's running.`);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        if (timedOut) throw new BackendError('timeout', 'The SignFlow backend took too long to respond.');
        data = undefined;
      }
      if (!response.ok) throw errorFromResponse(response.status, data);
      if (!guard(data)) throw new BackendError('invalid_response', 'The SignFlow backend sent an unexpected response.', response.status);
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    baseUrl,
    health: (opts) => call('GET', '/health', undefined, isHealthResponse, { timeoutMs: 5_000, ...opts }),
    translate: (body, opts) => call('POST', '/translate', body, isTranslationResponse, opts),
    speak: (body, opts) => call('POST', '/speak', body, isSpeechResponse, opts),
  };
}
