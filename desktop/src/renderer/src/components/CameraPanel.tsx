import { useEffect, type RefObject } from 'react';
import type { CameraController } from '../hooks/useCamera';
import type { AdapterStatus, RecognizedSign } from '../adapters/types';
import { formatPercent } from './ConfidenceMeter';

interface Props {
  camera: CameraController;
  videoRef: RefObject<HTMLVideoElement | null>;
  recognizerStatus: AdapterStatus;
  recognizerName: string;
  /** Newest sign, overlaid on the video. */
  latestSign: RecognizedSign | undefined;
  mirrored: boolean;
  onToggleMirror: () => void;
}

const STATUS_LABEL: Record<AdapterStatus['state'], string> = {
  idle: 'Recognizer idle',
  connecting: 'Connecting…',
  ready: 'Recognizing',
  error: 'Recognizer error',
};

export function CameraPanel({
  camera,
  videoRef,
  recognizerStatus,
  recognizerName,
  latestSign,
  mirrored,
  onToggleMirror,
}: Props) {
  const { status, error, stream, devices, deviceId } = camera;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) video.play().catch(() => undefined);
  }, [stream, videoRef]);

  const isOn = status === 'on';
  const recognizing = isOn && recognizerStatus.state === 'ready';

  return (
    <section className="panel camera-panel" aria-labelledby="camera-title">
      <div className="panel-head">
        <h2 id="camera-title" className="panel-title">
          Camera
        </h2>
        <div className="panel-actions">
          {devices.length > 1 && (
            <label className="select-inline">
              <span className="sr-only">Camera device</span>
              <select value={deviceId ?? ''} onChange={(e) => camera.selectDevice(e.target.value)}>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="btn btn-sm" onClick={onToggleMirror} aria-pressed={mirrored}>
            Mirror
          </button>
          {isOn || status === 'starting' ? (
            <button type="button" className="btn btn-sm" onClick={camera.stop}>
              Stop camera
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void camera.start()}>
              Start camera
            </button>
          )}
        </div>
      </div>

      <div className={`video-frame ${isOn ? 'is-on' : ''}`}>
        <video
          ref={videoRef}
          className={mirrored ? 'mirrored' : ''}
          muted
          playsInline
          autoPlay
          aria-label="Webcam preview"
          data-testid="webcam-video"
        />

        {!isOn && (
          <div className="video-placeholder">
            {status === 'starting' && <p>Starting camera…</p>}
            {status === 'off' && (
              <>
                <p className="video-placeholder-title">Camera is off</p>
                <p className="muted">Start the camera and sign within the frame. Good lighting helps.</p>
              </>
            )}
            {status === 'error' && error && (
              <div role="alert" className="camera-error">
                <p className="video-placeholder-title">Camera unavailable</p>
                <p>{error.message}</p>
                <button type="button" className="btn btn-sm" onClick={() => void camera.start()}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}

        {isOn && (
          <div className={`status-badge status-${recognizerStatus.state}`} data-testid="recognizer-status">
            <span className="status-dot" aria-hidden="true" />
            {STATUS_LABEL[recognizerStatus.state]}
            <span className="status-sub">· {recognizerName}</span>
          </div>
        )}

        {recognizing && latestSign && (
          <div className={`sign-overlay ${latestSign.final ? 'final' : 'provisional'}`} aria-hidden="true">
            <span className="sign-overlay-gloss">{latestSign.gloss}</span>
            <span className="sign-overlay-conf">{formatPercent(latestSign.confidence)}</span>
          </div>
        )}
      </div>
    </section>
  );
}
