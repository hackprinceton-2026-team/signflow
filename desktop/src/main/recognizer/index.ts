import { app, ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/ipc';
import { recognizerPort, validateRecognizerStart, type RecognizerStatus } from '@shared/recognizer';
import { isTrustedSender } from '../security';
import { RecognizerBridge, type SocketLike } from './bridge';

/**
 * The local ASL recognizer bridge. The main process is the only part of the app
 * that talks to ws://127.0.0.1:8765: the renderer's CSP stays as it is, and it
 * receives only validated, normalized events over IPC. Only the main window's
 * own page may start or stop it, and only the main window receives its events.
 */
export function registerRecognizer(getMainWindow: () => BrowserWindow | null): RecognizerBridge {
  const sendToMain = (channel: string, payload: unknown) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const bridge = new RecognizerBridge({
    port: recognizerPort(process.env['SIGNFLOW_RECOGNIZER_PORT']),
    connect: (url) => new WebSocket(url) as unknown as SocketLike,
    onEvent: (event) => sendToMain(IpcChannels.recognizerEvent, event),
    onStatus: (status) => sendToMain(IpcChannels.recognizerStatusChanged, status),
  });

  const handle = <T>(channel: string, handler: (...args: unknown[]) => T) => {
    ipcMain.handle(channel, (event, ...args) => {
      const main = getMainWindow();
      if (!main || event.sender !== main.webContents || !isTrustedSender(event.senderFrame)) {
        throw new Error(`Blocked IPC "${channel}" from untrusted sender`);
      }
      return handler(...args);
    });
  };
  handle<RecognizerStatus>(IpcChannels.recognizerStart, (request) => bridge.start(validateRecognizerStart(request)));
  handle<void>(IpcChannels.recognizerStop, () => bridge.stop());
  handle<RecognizerStatus>(IpcChannels.recognizerStatus, () => bridge.currentStatus());

  // No window to show signs in: stop connecting (macOS keeps the app alive).
  app.on('window-all-closed', () => bridge.stop());
  app.on('will-quit', () => bridge.stop());
  return bridge;
}
