import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '@shared/ipc';
import type { SignflowApi } from '@shared/api';
import type { CaptionPayload } from '@shared/captions';
import type { KokoroStatus } from '@shared/kokoro';
import type { RecognizerEvent, RecognizerStatus } from '@shared/recognizer';

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
  kokoro: {
    status: () => ipcRenderer.invoke(IpcChannels.kokoroStatus),
    prepare: () => ipcRenderer.invoke(IpcChannels.kokoroPrepare),
    synthesize: (request) => ipcRenderer.invoke(IpcChannels.kokoroSynthesize, request),
    cancel: (ids) => ipcRenderer.invoke(IpcChannels.kokoroCancel, ids),
    release: () => ipcRenderer.invoke(IpcChannels.kokoroRelease),
    onStatus: (cb) => subscribe<KokoroStatus>(IpcChannels.kokoroStatusChanged, cb),
  },
  recognizer: {
    start: (request) => ipcRenderer.invoke(IpcChannels.recognizerStart, request),
    stop: () => ipcRenderer.invoke(IpcChannels.recognizerStop),
    status: () => ipcRenderer.invoke(IpcChannels.recognizerStatus),
    onEvent: (cb) => subscribe<RecognizerEvent>(IpcChannels.recognizerEvent, cb),
    onStatus: (cb) => subscribe<RecognizerStatus>(IpcChannels.recognizerStatusChanged, cb),
  },
  view: {
    setFullScreen: (fullScreen) => ipcRenderer.invoke(IpcChannels.viewSetFullScreen, fullScreen),
    onFullScreenChange: (cb) => subscribe<boolean>(IpcChannels.viewFullScreenChanged, cb),
  },
};

contextBridge.exposeInMainWorld('signflow', api);
