import { app, ipcMain, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { IpcChannels, toCameraAccessStatus, type AppInfo, type CameraAccessStatus } from '@shared/ipc';
import { isTrustedSender } from './security';

type Handler<T> = (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>;

/** Register an invoke handler that rejects calls from untrusted frames. */
function handle<T>(channel: string, handler: Handler<T>): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event.senderFrame)) {
      throw new Error(`Blocked IPC "${channel}" from untrusted sender`);
    }
    return handler(event, ...args);
  });
}

function cameraStatus(): CameraAccessStatus {
  // Only macOS and Windows expose a system camera-privacy status.
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
  return toCameraAccessStatus(systemPreferences.getMediaAccessStatus('camera'));
}

export function registerIpcHandlers(): void {
  handle<AppInfo>(IpcChannels.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }));

  handle<CameraAccessStatus>(IpcChannels.cameraAccessStatus, () => cameraStatus());

  handle<CameraAccessStatus>(IpcChannels.cameraRequestAccess, async () => {
    // E2E runs use Chromium's fake camera; never block on a system dialog there.
    if (process.env['SIGNFLOW_E2E'] === '1') return 'granted';
    if (process.platform === 'darwin' && cameraStatus() === 'not-determined') {
      await systemPreferences.askForMediaAccess('camera');
    }
    return cameraStatus();
  });
}
