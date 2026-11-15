import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKEND_URL, BackendError, createBackendClient } from './backendClient';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const clientWith = (impl: (url: string, init?: RequestInit) => Promise<Response>, timeoutMs?: number) => {
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init));
  return { fetchFn, client: createBackendClient({ fetch: fetchFn as unknown as typeof fetch, ...(timeoutMs ? { timeoutMs } : {}) }) };
};
async function expectError(p: Promise<unknown>, kind: string, message?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BackendError);
  expect((err as BackendError).kind).toBe(kind);
  if (message) expect((err as BackendError).message).toMatch(message);
  return err as BackendError;
}

afterEach(() => vi.useRealTimers());

describe('createBackendClient', () => {
  it('targets the CSP-allowed backend origin by default', () => {
    expect(BACKEND_URL).toBe('http://localhost:8000');
    expect(createBackendClient().baseUrl).toBe('http://localhost:8000');
  });

  it('POSTs JSON without credentials and returns the validated response', async () => {
    const { client, fetchFn } = clientWith(async () => json(200, { translated_text: 'Hello.', mode: 'chat', model: 'm' }));
    await expect(client.translate({ raw_signs: ['HELLO'], mode: 'chat' })).resolves.toEqual({ translated_text: 'Hello.', mode: 'chat', model: 'm' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:8000/translate');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', body: '{"raw_signs":["HELLO"],"mode":"chat"}' });
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('maps a network failure to "offline" with a helpful message', async () => {
    const { client } = clientWith(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expectError(client.translate({ raw_signs: ['HI'] }), 'offline', /Can't reach the SignFlow backend at localhost:8000/);
  });

  it('times out slow requests', async () => {
    vi.useFakeTimers();
    const { client } = clientWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
      1000,
    );
    const p = expectError(client.translate({ raw_signs: ['HI'] }), 'timeout', /took too long/);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
  });

  it('honors caller cancellation', async () => {
    const ctrl = new AbortController();
    const { client } = clientWith(
      (_url, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    );
    const p = expectError(client.translate({ raw_signs: ['HI'] }, { signal: ctrl.signal }), 'aborted');
    ctrl.abort();
    await p;
    ctrl.abort();
    await expectError(client.translate({ raw_signs: ['HI'] }, { signal: ctrl.signal }), 'aborted');
  });

  it.each([
    [503, 'translation_unavailable', 'not_configured', /missing GOOGLE_API_KEY/],
    [422, 'invalid_request', 'rejected', /rejected the request: raw_signs/],
    [502, 'upstream_error', 'upstream', /AI service failed/],
    [504, 'upstream_timeout', 'upstream', /too long/],
  ])('maps HTTP %i (%s) to "%s" and shows the server message', async (status, code, kind, message) => {
    const messages: Record<string, string> = {
      translation_unavailable: 'Translation is not configured on the server (missing GOOGLE_API_KEY).',
      invalid_request: 'raw_signs: List should have at least 1 item',
      upstream_error: 'The AI service failed to respond. Try again.',
      upstream_timeout: 'The AI service took too long to respond. Try again.',
    };
    const { client } = clientWith(async () => json(status, { error: { code, message: messages[code] } }));
    const err = await expectError(client.translate({ raw_signs: ['HI'] }), kind, message);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });

  it('never shows unexpected server error bodies', async () => {
    const { client } = clientWith(async () => json(500, { detail: 'Traceback ... secret' }));
    const err = await expectError(client.translate({ raw_signs: ['HI'] }), 'server');
    expect(err.message).not.toMatch(/secret|Traceback/);
  });

  it('caps long server messages', async () => {
    const { client } = clientWith(async () => json(503, { error: { code: 'speech_unavailable', message: 'x'.repeat(1000) } }));
    const err = await expectError(client.speak({ text: 'Hi.' }), 'not_configured');
    expect(err.message.length).toBeLessThanOrEqual(300);
  });

  it('rejects responses that do not match the contract', async () => {
    const { client } = clientWith(async () => json(200, { text: 'wrong shape' }));
    await expectError(client.translate({ raw_signs: ['HI'] }), 'invalid_response');
    const { client: c2 } = clientWith(async () => new Response('not json', { status: 200 }));
    await expectError(c2.health(), 'invalid_response');
  });

  it('health uses GET with a short timeout', async () => {
    const { client, fetchFn } = clientWith(async () =>
      json(200, { status: 'ok', version: '0.2.0', translation: 'ready', speech: 'not_configured', model: 'm' }),
    );
    await expect(client.health()).resolves.toMatchObject({ translation: 'ready' });
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });
});
