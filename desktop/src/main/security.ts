import { pathToFileURL } from 'node:url';
import { app, net, protocol, session, shell, type WebContents, type WebFrameMain } from 'electron';
import { buildCsp } from '@shared/csp';
import { isTrustedRendererUrl, resolveInside } from './trust';

/**
 * Production renderers are served from a custom privileged scheme instead of
 * file://, so they get a real, isolated origin (app://signflow) and can't read
 * arbitrary files. See https://www.electronjs.org/docs/latest/tutorial/security
 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'signflow';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const isDev = !app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL']);
const devUrl = process.env['ELECTRON_RENDERER_URL'];

export const CSP = buildCsp(isDev ? 'development' : 'production');

/** Must run before `app.whenReady()`. */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = resolveInside(rendererRoot, pathname);
    if (!file) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}

/** Is this URL one of our own renderer pages? */
export function isTrustedUrl(rawUrl: string | undefined | null): boolean {
  return isTrustedRendererUrl(rawUrl, { appScheme: APP_SCHEME, appHost: APP_HOST, devUrl: isDev ? devUrl : undefined });
}

/** Validate that an IPC message came from one of our own top-level frames. */
export function isTrustedSender(frame: WebFrameMain | null | undefined): boolean {
  if (!frame) return false;
  if (frame.parent) return false; // no sub-frames
  return isTrustedUrl(frame.url);
}

/** Session-wide hardening: permissions, CSP header, device access. */
export function hardenDefaultSession(): void {
  const ses = session.defaultSession;

  // Only the camera is granted, and only to our own pages. Everything else
  // (mic, geolocation, notifications, clipboard-read, HID, ...) is denied.
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = isTrustedUrl(details.requestingUrl ?? webContents.getURL());
    if (permission === 'media' && trusted) {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      callback(types.length > 0 && types.every((t) => t === 'video'));
      return;
    }
    callback(false);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permission === 'media' && isTrustedUrl(requestingOrigin);
  });

  ses.setDevicePermissionHandler(() => false);

  // Defense in depth: send the CSP header on dev-server responses too.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

/** Applied to every WebContents the app ever creates. */
export function hardenWebContents(contents: WebContents): void {
  // No in-app navigation away from our pages.
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });

  // No new windows; https links open in the system browser instead.
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // <webview> is never used.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
