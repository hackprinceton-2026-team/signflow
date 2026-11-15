import http from 'node:http';
import https from 'node:https';

/**
 * The Kokoro utility process must never reach the network: user text stays on
 * this device, and the model loads only from local files. transformers.js is
 * already configured with `allowRemoteModels = false`; this guard is defense in
 * depth against any library code path that would still try to fetch.
 *
 * Only `file:` URLs pass through fetch. Every http(s) request throws.
 */
export function installNetworkGuard(onBlocked: (url: string) => void = () => undefined): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('file:') && realFetch) return realFetch(input, init);
    onBlocked(url);
    throw new Error(`SignFlow blocks network access from the local voice engine (${url})`);
  }) as typeof fetch;

  const block = (mod: typeof http | typeof https, scheme: string) => {
    const deny = (...args: unknown[]): never => {
      const first = args[0];
      const url = typeof first === 'string' ? first : first instanceof URL ? first.href : `${scheme}://…`;
      onBlocked(url);
      throw new Error(`SignFlow blocks network access from the local voice engine (${url})`);
    };
    mod.request = deny as typeof mod.request;
    mod.get = deny as typeof mod.get;
  };
  block(http, 'http');
  block(https, 'https');
}
