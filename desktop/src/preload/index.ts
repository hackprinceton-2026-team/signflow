import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '@shared/ipc';
import type { SignflowApi } from '@shared/api';

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
};

contextBridge.exposeInMainWorld('signflow', api);
