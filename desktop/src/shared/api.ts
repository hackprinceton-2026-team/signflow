import type { AppInfo, CameraAccessStatus, NotesExportRequest, NotesExportResult } from './ipc';

/**
 * Shape of `window.signflow`, the only bridge between renderer and main.
 * Implemented in src/preload/index.ts; pure types so the renderer can import it.
 */
export interface SignflowApi {
  getAppInfo(): Promise<AppInfo>;
  camera: {
    accessStatus(): Promise<CameraAccessStatus>;
    requestAccess(): Promise<CameraAccessStatus>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
  };
  notes: {
    /** Shows a native Save dialog; writes only the file the user picks. */
    exportMarkdown(request: NotesExportRequest): Promise<NotesExportResult>;
  };
}
