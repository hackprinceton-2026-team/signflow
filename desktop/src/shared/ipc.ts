/**
 * IPC contract between the main process and renderers.
 *
 * Every channel name is listed here, and every payload that crosses the
 * boundary has a runtime validator: renderer input is untrusted.
 */

export const IpcChannels = {
  appInfo: 'app:info',
  cameraAccessStatus: 'camera:access-status',
  cameraRequestAccess: 'camera:request-access',
  clipboardWriteText: 'clipboard:write-text',
  notesExport: 'notes:export',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
}

export type CameraAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

const CAMERA_STATUSES: readonly CameraAccessStatus[] = [
  'not-determined',
  'granted',
  'denied',
  'restricted',
  'unknown',
];

export function toCameraAccessStatus(value: unknown): CameraAccessStatus {
  return CAMERA_STATUSES.includes(value as CameraAccessStatus) ? (value as CameraAccessStatus) : 'unknown';
}

// ---------- Clipboard ----------

export const MAX_CLIPBOARD_CHARS = 1_000_000;

export function validateClipboardText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Clipboard text must be a string');
  if (value.length > MAX_CLIPBOARD_CHARS) throw new RangeError('Clipboard text is too long');
  return value;
}

// ---------- Notes export ----------

export const MAX_EXPORT_CHARS = 5_000_000;

export interface NotesExportRequest {
  suggestedName: string;
  content: string;
}

export interface NotesExportResult {
  saved: boolean;
  /** Basename only. The renderer never learns full filesystem paths. */
  fileName?: string;
}

/** Make a safe default file name: no path separators, control or reserved chars. */
export function sanitizeFileName(name: string, fallback = 'SignFlow notes'): string {
  const cleaned = name
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- intentionally strips control characters
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

export function validateNotesExport(value: unknown): NotesExportRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Export request must be an object');
  const { suggestedName, content } = value as Record<string, unknown>;
  if (typeof content !== 'string') throw new TypeError('Export content must be a string');
  if (content.length > MAX_EXPORT_CHARS) throw new RangeError('Export content is too large');
  return {
    suggestedName: sanitizeFileName(typeof suggestedName === 'string' ? suggestedName : ''),
    content,
  };
}
