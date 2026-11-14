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
