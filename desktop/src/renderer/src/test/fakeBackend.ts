import { vi } from 'vitest';
import { createBackendClient } from '../adapters/remote/backendClient';
import type { TranslationMode } from '../adapters/remote/guards';

export interface FakeBackendState {
  offline: boolean;
  translationConfigured: boolean;
  speechConfigured: boolean;
  /** How the fake "AI" turns glosses into English. */
  translate: (glosses: string[], mode: TranslationMode) => string;
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * An in-memory SignFlow backend speaking the contract's shapes (backend/openapi.json),
 * recording every request so tests can assert what was sent, and when.
 */
export function createFakeBackend(initial: Partial<FakeBackendState> = {}) {
  const state: FakeBackendState = {
    offline: false,
    translationConfigured: true,
    speechConfigured: true,
    translate: (glosses) => `[AI] ${glosses.join(' ').toLowerCase()}.`,
    ...initial,
  };
  const calls: RecordedCall[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (state.offline) throw new TypeError('Failed to fetch');

    if (url.pathname === '/health') {
      return json(200, {
        status: 'ok',
        version: '0.3.0',
        translation: state.translationConfigured ? 'ready' : 'not_configured',
        speech: state.speechConfigured ? 'ready' : 'not_configured',
        model: 'gemini-test',
        speech_voice: 'Ruth',
        speech_engine: 'generative',
      });
    }
    if (url.pathname === '/translate') {
      if (!state.translationConfigured) {
        return json(503, {
          error: { code: 'translation_unavailable', message: 'Translation is not configured on the server (missing GOOGLE_API_KEY).' },
        });
      }
      const req = body as { raw_signs: string[]; mode?: TranslationMode };
      const mode = req.mode ?? 'chat';
      return json(200, { translated_text: state.translate(req.raw_signs, mode), mode, model: 'gemini-test' });
    }
    if (url.pathname === '/speak') {
      if (!state.speechConfigured) {
        return json(503, { error: { code: 'speech_unavailable', message: 'Speech is not configured on the server (no AWS credentials).' } });
      }
      const req = body as { voice_id?: string };
      const voice = req.voice_id ?? 'Ruth';
      // Mirrors Polly: these voices support the Generative engine; others fall back to Neural.
      const engine = ['Ruth', 'Danielle', 'Matthew'].includes(voice) ? 'generative' : 'neural';
      return json(200, { audio_base64: btoa('ID3fake'), audio_format: 'mp3', voice_id: voice, engine });
    }
    return json(404, { error: { code: 'not_found', message: 'Not found.' } });
  });

  return {
    state,
    calls,
    fetch: fetchImpl,
    client: createBackendClient({ fetch: fetchImpl as unknown as typeof fetch, baseUrl: 'http://localhost:8000' }),
    callsTo: (path: string) => calls.filter((c) => c.path === path),
  };
}
