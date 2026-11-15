import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus = 'off' | 'starting' | 'on' | 'error';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraError {
  kind: 'permission' | 'no-device' | 'in-use' | 'unsupported' | 'unknown';
  message: string;
}

export function describeCameraError(err: unknown): CameraError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        kind: 'permission',
        message:
          'Camera access was denied. On macOS, enable SignFlow (or your terminal in dev) under System Settings → Privacy & Security → Camera.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { kind: 'no-device', message: 'No camera found. Connect a webcam and try again.' };
    case 'NotReadableError':
    case 'AbortError':
      return { kind: 'in-use', message: 'The camera is busy. Close other apps using it (Zoom, FaceTime…) and retry.' };
    default:
      return { kind: 'unknown', message: err instanceof Error ? err.message : 'Could not start the camera.' };
  }
}

async function listCameras(): Promise<CameraDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** Webcam lifecycle: permission, device selection, start/stop, cleanup. */
export function useCamera() {
  const [status, setStatus] = useState<CameraStatus>('off');
  const [error, setError] = useState<CameraError | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const streamRef = useRef<MediaStream | null>(null);
  const requestSeq = useRef(0);

  const refreshDevices = useCallback(() => {
    listCameras()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const stop = useCallback(() => {
    requestSeq.current += 1; // cancel any in-flight start
    releaseStream();
    setStatus('off');
  }, [releaseStream]);

  const start = useCallback(
    async (preferredDeviceId: string | undefined = deviceId) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError({ kind: 'unsupported', message: 'Camera API is not available in this environment.' });
        setStatus('error');
        return;
      }
      const seq = ++requestSeq.current;
      setStatus('starting');
      setError(null);
      try {
        const access = await window.signflow.camera.requestAccess();
        if (seq !== requestSeq.current) return; // stopped (or unmounted) while the OS asked for permission
        if (access === 'denied' || access === 'restricted') {
          throw new DOMException('Camera access denied by the operating system', 'NotAllowedError');
        }
        const media = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
            ...(preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : {}),
          },
        });
        if (seq !== requestSeq.current) {
          media.getTracks().forEach((t) => t.stop()); // superseded by stop() or another start()
          return;
        }
        releaseStream();
        streamRef.current = media;
        setStream(media);
        setStatus('on');
        const activeId = media.getVideoTracks()[0]?.getSettings().deviceId;
        if (activeId) setDeviceId(activeId);
        // The camera can disappear (unplugged, taken by another app).
        media.getVideoTracks().forEach((track) =>
          track.addEventListener('ended', () => {
            if (streamRef.current !== media) return;
            releaseStream();
            setError({ kind: 'in-use', message: 'The camera stopped unexpectedly.' });
            setStatus('error');
          }),
        );
        refreshDevices(); // labels become available after permission
      } catch (err) {
        if (seq !== requestSeq.current) return;
        releaseStream();
        setError(describeCameraError(err));
        setStatus('error');
      }
    },
    [deviceId, refreshDevices, releaseStream],
  );

  const selectDevice = useCallback(
    (id: string) => {
      setDeviceId(id);
      if (streamRef.current) void start(id);
    },
    [start],
  );

  useEffect(() => {
    let alive = true;
    const load = () => {
      listCameras()
        .then((list) => alive && setDevices(list))
        .catch(() => undefined);
    };
    load();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', load);
    return () => {
      alive = false;
      md?.removeEventListener?.('devicechange', load);
    };
  }, []);

  // Always release the camera on unmount, including one that is still starting:
  // bumping the sequence makes a getUserMedia that resolves later stop its tracks.
  useEffect(
    () => () => {
      requestSeq.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );

  return { status, error, stream, devices, deviceId, start, stop, selectDevice };
}

export type CameraController = ReturnType<typeof useCamera>;
