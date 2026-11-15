import type { ReactNode } from 'react';
import type { AdapterStatus } from '../adapters/types';
import type { CameraController } from '../hooks/useCamera';
import { Button, Icon, IconButton, SelectField, StatusPill, type StatusTone } from '../ui';
import { CameraView } from './CameraView';

interface Props {
  camera: CameraController;
  mirrored: boolean;
  onToggleMirror: () => void;
  recognizerStatus: AdapterStatus;
  recognizerName: string;
  /** The demo recognizer plays scripted signs: say so on the stage. */
  recognizerSimulated?: boolean;
  /**
   * The recognizer receives encoded camera frames (`frameFormat: 'jpeg'`), e.g. a
   * model behind the backend. The privacy note must not claim video stays local then.
   */
  recognizerTakesVideo?: boolean;
  /** Overlays anchored to the bottom of the stage (ticker, draft). */
  children?: ReactNode;
  /**
   * Keep the overlays visible with the camera off (a draft, translation, or error
   * is still pending), so stopping the camera never hides text awaiting a decision.
   */
  keepOverlays?: boolean;
  /** Extra controls for the top-right cluster (e.g. exit Focus Mode). */
  extraControls?: ReactNode;
  /**
   * The recognizer is a separate process that owns the camera (the local ASL
   * model). The stage then never opens the camera: it starts and stops
   * recognition, and says where the camera preview is.
   */
  external?: ExternalRecognition | undefined;
}

export interface ExternalRecognition {
  on: boolean;
  start: () => void;
  stop: () => void;
  /** Fall back to the demo recognizer (shown while the recognizer can't be reached). */
  onUseDemo?: () => void;
  /** The recognizer's own camera preview (SignFlow's launcher sends it), as an <img> source. */
  preview?: { src: string; width: number; height: number } | null;
}

const RECOGNIZER: Record<AdapterStatus['state'], { label: string; tone: StatusTone }> = {
  idle: { label: 'Recognizer idle', tone: 'neutral' },
  connecting: { label: 'Connecting…', tone: 'warning' },
  ready: { label: 'Recognizing', tone: 'success' },
  error: { label: 'Recognizer error', tone: 'danger' },
};

/** The camera, edge to edge, with status and controls floating over it. */
export function CameraStage({
  camera,
  mirrored,
  onToggleMirror,
  recognizerStatus,
  recognizerName,
  recognizerSimulated = false,
  recognizerTakesVideo = false,
  children,
  extraControls,
  keepOverlays = false,
  external,
}: Props) {
  const rec = RECOGNIZER[recognizerStatus.state];
  if (external) {
    return (
      <ExternalStage
        external={external}
        recognizerStatus={recognizerStatus}
        recognizerName={recognizerName}
        keepOverlays={keepOverlays}
        extraControls={extraControls}
      >
        {children}
      </ExternalStage>
    );
  }
  const { status, error, stream, devices, deviceId } = camera;
  const on = status === 'on';

  return (
    <section className={`stage ${on ? 'is-on' : ''} ${!on && keepOverlays ? 'has-overlay' : ''}`} aria-label="Camera">
      <CameraView stream={stream} mirrored={mirrored} className="stage-video" label="Webcam preview" testId="webcam-video" />
      <div className="stage-vignette" aria-hidden="true" />
      {on && <div className="stage-guides" aria-hidden="true" />}

      {!on && (
        <div className="stage-empty">
          {status === 'error' && error ? (
            <div className="stage-empty-card" role="alert">
              <span className="stage-empty-icon is-danger">
                <Icon name="cameraOff" size={26} />
              </span>
              <h2 className="stage-empty-title">Camera unavailable</h2>
              <p className="stage-empty-text">{error.message}</p>
              <Button variant="primary" size="lg" icon="retry" onClick={() => void camera.start()}>
                Try again
              </Button>
            </div>
          ) : status === 'starting' ? (
            <div className="stage-empty-card" role="status">
              <span className="stage-empty-icon">
                <span className="ui-spinner" aria-hidden="true" />
              </span>
              <h2 className="stage-empty-title">Starting camera…</h2>
              <p className="stage-empty-text">Allow camera access if your system asks.</p>
              <Button variant="ghost" onClick={camera.stop}>
                Stop camera
              </Button>
            </div>
          ) : (
            <div className="stage-empty-card">
              <span className="stage-empty-icon">
                <Icon name="camera" size={26} />
              </span>
              <h2 className="stage-empty-title">Camera is off</h2>
              <p className="stage-empty-text">
                Start the camera and sign within the frame. Good, even lighting helps recognition.
              </p>
              <Button variant="primary" size="lg" icon="camera" onClick={() => void camera.start()}>
                Start camera
              </Button>
              <p className="stage-empty-note">
                <Icon name="shield" size={14} />{' '}
                {recognizerTakesVideo
                  ? 'Camera frames are sent to the sign recognition model while the camera is on.'
                  : 'Video never leaves this device. Live mode sends only text to the SignFlow backend: recognized signs, and confirmed sentences if the cloud voice is on.'}
              </p>
            </div>
          )}
        </div>
      )}

      {on && (
        <div className="stage-top">
          <div className="stage-top-pills">
            <StatusPill glass tone={rec.tone} pulse={recognizerStatus.state === 'ready'} data-testid="recognizer-status">
              {rec.label}
              <span className="stage-top-sub">· {recognizerName}</span>
            </StatusPill>
            {recognizerSimulated && (
              <StatusPill
                glass
                tone="warning"
                data-testid="simulated-signs"
                title="Demo recognizer: plays scripted ASL signs with simulated confidence while the camera runs. It does not read your signing yet."
              >
                Simulated signs
              </StatusPill>
            )}
          </div>
          <div className="stage-controls">
            {devices.length > 1 && (
              <SelectField
                label="Camera device"
                hideLabel
                className="stage-device"
                value={deviceId ?? ''}
                options={devices.map((d) => ({ value: d.deviceId, label: d.label }))}
                onChange={camera.selectDevice}
              />
            )}
            <IconButton icon="mirror" label="Mirror preview" variant="glass" aria-pressed={mirrored} onClick={onToggleMirror} />
            <Button variant="glass" icon="cameraOff" onClick={camera.stop}>
              Stop camera
            </Button>
            {extraControls}
          </div>
        </div>
      )}

      {(on || keepOverlays) && <div className="stage-bottom">{children}</div>}
    </section>
  );
}

/** The stage when a separate recognizer process owns the camera. */
function ExternalStage({
  external,
  recognizerStatus,
  recognizerName,
  keepOverlays,
  extraControls,
  children,
}: {
  external: ExternalRecognition;
  recognizerStatus: AdapterStatus;
  recognizerName: string;
  keepOverlays: boolean;
  extraControls?: ReactNode;
  children?: ReactNode;
}) {
  const { on, preview } = external;
  const rec = RECOGNIZER[recognizerStatus.state];
  const unreachable = recognizerStatus.state === 'connecting' || recognizerStatus.state === 'error';
  const showPreview = on && Boolean(preview);
  return (
    <section
      className={`stage stage-external ${on ? 'is-on' : ''} ${showPreview ? 'has-preview' : ''} ${!on && keepOverlays ? 'has-overlay' : ''}`}
      aria-label="Sign recognition"
      data-testid="external-stage"
    >
      {showPreview && preview && (
        // The recognizer's camera, as it sees it (mirrored, with hand tracking). It owns the camera;
        // these are small JPEG frames it sends over loopback. SignFlow never opens the camera.
        <img
          className="stage-video stage-preview"
          src={preview.src}
          width={preview.width}
          height={preview.height}
          alt="Camera preview from the sign recognizer, with hand tracking"
          data-testid="recognizer-preview"
        />
      )}
      <div className="stage-vignette" aria-hidden="true" />
      <div className="stage-empty">
        {showPreview ? null : on ? (
          <div className="stage-empty-card" role="status">
            <span className={`stage-empty-icon ${recognizerStatus.state === 'error' ? 'is-danger' : ''}`}>
              {recognizerStatus.state === 'ready' ? <Icon name="camera" size={26} /> : <span className="ui-spinner" aria-hidden="true" />}
            </span>
            <h2 className="stage-empty-title">
              {recognizerStatus.state === 'ready'
                ? 'Sign in front of the recognizer'
                : recognizerStatus.state === 'error'
                  ? 'Recognizer problem'
                  : 'Waiting for the recognizer'}
            </h2>
            <p className="stage-empty-text" data-testid="external-stage-message">
              {recognizerStatus.state === 'ready'
                ? 'The camera preview and hand tracking are in the SignFlow Recognizer window. Raise your hands to sign, lower them to end a sign; hands down for 1.5 s ends the sentence.'
                : (recognizerStatus.message ?? 'Connecting to the SignFlow ASL recognizer…')}
            </p>
            {unreachable && external.onUseDemo && (
              <Button variant="ghost" onClick={external.onUseDemo}>
                Use the demo recognizer instead
              </Button>
            )}
          </div>
        ) : (
          <div className="stage-empty-card">
            <span className="stage-empty-icon">
              <Icon name="sparkle" size={26} />
            </span>
            <h2 className="stage-empty-title">Sign recognition is off</h2>
            <p className="stage-empty-text">
              The SignFlow ASL recognizer runs as its own app and uses the camera itself. Start it, keep its window next to
              SignFlow, then start recognition here.
            </p>
            <Button variant="primary" size="lg" icon="play" onClick={external.start}>
              Start recognition
            </Button>
            <p className="stage-empty-note">
              <Icon name="shield" size={14} /> Video stays in the recognizer on this device. SignFlow receives only the recognized
              signs.
            </p>
          </div>
        )}
      </div>

      {on && (
        <div className="stage-top">
          <div className="stage-top-pills">
            <StatusPill glass tone={rec.tone} pulse={recognizerStatus.state === 'ready'} data-testid="recognizer-status">
              {rec.label}
              <span className="stage-top-sub">
                · {recognizerName}
                {recognizerStatus.state === 'ready' && recognizerStatus.message ? ` (${recognizerStatus.message})` : ''}
              </span>
            </StatusPill>
          </div>
          <div className="stage-controls">
            <Button variant="glass" icon="stop" onClick={external.stop}>
              Stop recognition
            </Button>
            {extraControls}
          </div>
        </div>
      )}

      {(on || keepOverlays) && <div className="stage-bottom">{children}</div>}
    </section>
  );
}
