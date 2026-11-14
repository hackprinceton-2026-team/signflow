/**
 * Content Security Policy for every SignFlow renderer.
 *
 * Shared by the Vite build (which injects a <meta> tag) and the main process
 * (which also sends it as a response header), so the two can't drift apart.
 */

/** Backend origins the real adapters may talk to (see docs/interfaces.md). */
export const BACKEND_ORIGINS = ['http://localhost:8000', 'ws://localhost:8000'] as const;

export function buildCsp(mode: 'development' | 'production'): string {
  const dev = mode === 'development';
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // Vite's React Fast Refresh preamble is an inline script in dev only.
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // Vite injects <style> tags in dev; production CSS ships as files.
    'style-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'blob:', 'mediastream:'],
    'font-src': ["'self'"],
    'connect-src': dev
      ? ["'self'", 'ws://localhost:*', 'http://localhost:*', ...BACKEND_ORIGINS]
      : ["'self'", ...BACKEND_ORIGINS],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'worker-src': ["'self'", 'blob:'],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}
