import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { EMPTY_CAPTIONS, sanitizeCaptionPayload, type CaptionPayload } from '@shared/captions';
import { IpcChannels } from '@shared/ipc';
import { isTrustedSender } from './security';
import { recordPrefsForE2e, rendererUrl, secureWebPreferences } from './windows';

/**
 * Owns the floating captions window: a frameless, transparent, always-on-top
 * overlay that stays visible over other apps (including full-screen video calls).
 *
 * Only the main window may push captions or toggle visibility; only the captions
 * window may read state or close itself. Payloads are validated in main.
 */
export class CaptionsController {
  private win: BrowserWindow | null = null;
  private state: CaptionPayload = EMPTY_CAPTIONS;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  get visible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed());
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
      return;
    }
    const { workArea } = screen.getPrimaryDisplay();
    const width = Math.min(960, workArea.width - 80);
    const height = 180;
    const webPreferences = secureWebPreferences();

    const win = new BrowserWindow({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + workArea.height - height - 40),
      minWidth: 360,
      minHeight: 90,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: 'SignFlow Captions',
      webPreferences,
    });
    recordPrefsForE2e(win, webPreferences);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Show without stealing focus from the main window.
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.notifyVisibility();
    });
    void win.loadURL(rendererUrl('captions'));
    this.win = win;
    this.notifyVisibility();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }

  update(payload: CaptionPayload): void {
    this.state = payload;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(IpcChannels.captionsRender, payload);
  }

  private notifyVisibility(): void {
    const main = this.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(IpcChannels.captionsVisibility, this.visible);
  }

  private fromMain(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const main = this.getMainWindow();
    return Boolean(main && event.sender === main.webContents && isTrustedSender(event.senderFrame));
  }

  private fromCaptions(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return Boolean(this.win && event.sender === this.win.webContents && isTrustedSender(event.senderFrame));
  }

  registerIpc(): void {
    ipcMain.handle(IpcChannels.captionsSetVisible, (event, visible: unknown) => {
      if (!this.fromMain(event)) throw new Error('Blocked captions:set-visible from untrusted sender');
      if (typeof visible !== 'boolean') throw new TypeError('visible must be a boolean');
      if (visible) this.show();
      else this.hide();
      return visible;
    });

    ipcMain.on(IpcChannels.captionsUpdate, (event, payload: unknown) => {
      if (!this.fromMain(event)) return;
      try {
        this.update(sanitizeCaptionPayload(payload));
      } catch {
        /* ignore malformed payloads */
      }
    });

    ipcMain.handle(IpcChannels.captionsGetState, (event) => {
      if (!this.fromCaptions(event)) throw new Error('Blocked captions:get-state from untrusted sender');
      return this.state;
    });

    ipcMain.on(IpcChannels.captionsClose, (event) => {
      if (this.fromCaptions(event)) this.hide();
    });
  }
}
