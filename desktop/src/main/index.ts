import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  hardenDefaultSession,
  hardenWebContents,
  registerAppProtocol,
  registerPrivilegedSchemes,
} from './security';
import { createMainWindow } from './windows';
import { registerIpcHandlers } from './ipc';

// Sandbox every renderer, including any created by Electron internals.
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerPrivilegedSchemes();

  let mainWindow: BrowserWindow | null = null;

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

  void app.whenReady().then(() => {
    registerAppProtocol(join(__dirname, '../renderer'));
    hardenDefaultSession();
    registerIpcHandlers();

    mainWindow = createMainWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
