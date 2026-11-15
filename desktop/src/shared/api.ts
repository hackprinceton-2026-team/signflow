import type { CaptionPayload } from './captions';
import type { KokoroStatus, KokoroSynthesizeRequest, KokoroSynthesizeResult } from './kokoro';
import type { RecognizerEvent, RecognizerStartRequest, RecognizerStatus } from './recognizer';
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
  captions: {
    // Used by the main window:
    setVisible(visible: boolean): Promise<boolean>;
    update(payload: CaptionPayload): void;
    onVisibilityChange(cb: (visible: boolean) => void): () => void;
    // Used by the captions window:
    getState(): Promise<CaptionPayload>;
    onRender(cb: (payload: CaptionPayload) => void): () => void;
    close(): void;
  };
  /** Kokoro-82M local neural voice (runs in a separate local process; never uses the network). */
  kokoro: {
    status(): Promise<KokoroStatus>;
    /** Start the engine and load the model if needed. */
    prepare(): Promise<KokoroStatus>;
    /** Synthesize one chunk of confirmed text. Rejects with a coded error (see decodeKokoroError). */
    synthesize(request: KokoroSynthesizeRequest): Promise<KokoroSynthesizeResult>;
    /** Drop pending requests: the given ids, or all. */
    cancel(ids?: string[]): Promise<void>;
    /** Stop the engine and free the model's memory (it reloads on next use). */
    release(): Promise<void>;
    onStatus(cb: (status: KokoroStatus) => void): () => void;
  };
  /**
   * The local ASL recognizer (a separate process that owns the camera). Main
   * window only. Events are validated and normalized in the main process.
   */
  recognizer: {
    start(request: RecognizerStartRequest): Promise<RecognizerStatus>;
    stop(): Promise<void>;
    status(): Promise<RecognizerStatus>;
    onEvent(cb: (event: RecognizerEvent) => void): () => void;
    onStatus(cb: (status: RecognizerStatus) => void): () => void;
  };
  view: {
    /** Main window only. Resolves to the requested state. */
    setFullScreen(fullScreen: boolean): Promise<boolean>;
    onFullScreenChange(cb: (fullScreen: boolean) => void): () => void;
  };
}
