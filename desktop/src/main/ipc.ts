import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import {
  IpcChannels,
  toCameraAccessStatus,
  validateClipboardText,
  validateNotesExport,
  type AppInfo,
  type CameraAccessStatus,
  type NotesExportResult,
} from '@shared/ipc';
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

  handle<void>(IpcChannels.clipboardWriteText, (_event, text) => {
    clipboard.writeText(validateClipboardText(text));
  });

  handle<NotesExportResult>(IpcChannels.notesExport, async (event, request) => {
    const { suggestedName, content } = validateNotesExport(request);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
      title: 'Export notes',
      defaultPath: join(app.getPath('documents'), `${suggestedName}.md`),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Plain text', extensions: ['txt'] },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };
    // Only the path the user chose in the native dialog is ever written.
    await writeFile(result.filePath, content, 'utf8');
    return { saved: true, fileName: basename(result.filePath) };
  });
}
