import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '@shared/ipc';
import type { SignflowApi } from '@shared/api';
import type { CaptionPayload } from '@shared/captions';

/** Subscribe to a main→renderer channel without leaking the IpcRendererEvent. */
function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * The ONLY surface the renderer gets. Never expose `ipcRenderer` itself or
 * generic send/invoke helpers: each capability is a narrow, typed function.
 */
const api: SignflowApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.appInfo),
  camera: {
    accessStatus: () => ipcRenderer.invoke(IpcChannels.cameraAccessStatus),
    requestAccess: () => ipcRenderer.invoke(IpcChannels.cameraRequestAccess),
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke(IpcChannels.clipboardWriteText, text),
  },
  notes: {
    exportMarkdown: (request) => ipcRenderer.invoke(IpcChannels.notesExport, request),
  },
  captions: {
    setVisible: (visible) => ipcRenderer.invoke(IpcChannels.captionsSetVisible, visible),
    update: (payload) => ipcRenderer.send(IpcChannels.captionsUpdate, payload),
    onVisibilityChange: (cb) => subscribe<boolean>(IpcChannels.captionsVisibility, cb),
    getState: () => ipcRenderer.invoke(IpcChannels.captionsGetState),
    onRender: (cb) => subscribe<CaptionPayload>(IpcChannels.captionsRender, cb),
    close: () => ipcRenderer.send(IpcChannels.captionsClose),
  },
  view: {
    setFullScreen: (fullScreen) => ipcRenderer.invoke(IpcChannels.viewSetFullScreen, fullScreen),
    onFullScreenChange: (cb) => subscribe<boolean>(IpcChannels.viewFullScreenChanged, cb),
  },
};

contextBridge.exposeInMainWorld('signflow', api);
