import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/ipc';
import { isTrustedSender } from './security';

/**
 * Window fullscreen for Focus Mode. Only the main window's own top-level page
 * may toggle it, and only with a boolean.
 */
export function registerViewControls(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IpcChannels.viewSetFullScreen, (event, fullScreen: unknown) => {
    const main = getMainWindow();
    if (!main || event.sender !== main.webContents || !isTrustedSender(event.senderFrame)) {
      throw new Error('Blocked view:set-fullscreen from untrusted sender');
    }
    if (typeof fullScreen !== 'boolean') throw new TypeError('fullScreen must be a boolean');
    main.setFullScreen(fullScreen);
    return fullScreen;
  });
}

/** Tell the renderer when fullscreen changes, including via the OS (green button, ⌃⌘F). */
export function forwardFullScreenEvents(win: BrowserWindow): void {
  const send = (value: boolean) => {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.viewFullScreenChanged, value);
  };
  win.on('enter-full-screen', () => send(true));
  win.on('leave-full-screen', () => send(false));
}
