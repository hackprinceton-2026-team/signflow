import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import {
  hardenDefaultSession,
  hardenWebContents,
  registerAppProtocol,
  registerPrivilegedSchemes,
} from './security';
import { createMainWindow } from './windows';
import { registerIpcHandlers } from './ipc';
import { CaptionsController } from './captions';
import { forwardFullScreenEvents, registerViewControls } from './view';
import { registerKokoro } from './kokoro';

// Sandbox every renderer, including any created by Electron internals.
app.enableSandbox();

// E2E runs get a throwaway profile so tests never touch real notes/settings.
const e2eUserData = process.env['SIGNFLOW_E2E'] === '1' ? process.env['SIGNFLOW_USER_DATA'] : undefined;
if (e2eUserData) app.setPath('userData', e2eUserData);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerPrivilegedSchemes();

  let mainWindow: BrowserWindow | null = null;
  const captions = new CaptionsController(() => mainWindow);

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
    captions.registerIpc();
    registerViewControls(() => mainWindow);
    registerKokoro(() => mainWindow);

    const openMainWindow = () => {
      const win = createMainWindow();
      forwardFullScreenEvents(win);
      // The captions overlay never outlives the main window.
      win.on('closed', () => {
        if (mainWindow === win) mainWindow = null;
        captions.hide();
      });
      mainWindow = win;
    };
    openMainWindow();

    app.on('activate', () => {
      if (!mainWindow) openMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
