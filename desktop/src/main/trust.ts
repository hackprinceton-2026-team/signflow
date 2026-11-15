import { isAbsolute, join, normalize, relative } from 'node:path';

/** Resolve `requestPath` inside `root`, or return null on traversal attempts. */
export function resolveInside(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const target = normalize(join(root, decoded));
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

/**
 * Does `rawUrl` belong to one of our renderer origins?
 *
 * Compares protocol + host rather than `URL.origin`: for custom schemes such as
 * `app:` the WHATWG URL parser reports `origin === "null"`, so origin equality
 * would silently reject our own pages.
 */
export function isTrustedRendererUrl(
  rawUrl: string | undefined | null,
  opts: { appScheme: string; appHost: string; devUrl?: string | undefined },
): boolean {
  if (!rawUrl) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === `${opts.appScheme}:` && url.host === opts.appHost && !url.username && !url.password) {
    return true;
  }
  if (opts.devUrl) {
    try {
      const dev = new URL(opts.devUrl);
      return url.protocol === dev.protocol && url.host === dev.host;
    } catch {
      return false;
    }
  }
  return false;
}
