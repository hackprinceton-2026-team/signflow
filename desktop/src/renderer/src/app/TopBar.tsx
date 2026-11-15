import type { AdapterStatus } from '../adapters/types';
import type { BackendStatus } from '../hooks/useBackendHealth';
import { IconButton, StatusPill, type StatusTone } from '../ui';
import { shortcutLabel } from '../ui/Kbd';
import { SCREENS, type ScreenId } from './screens';
import { useSignFlow } from './useSignFlow';

const RECOGNIZER: Record<AdapterStatus['state'], { label: string; tone: StatusTone }> = {
  idle: { label: 'Recognizer idle', tone: 'neutral' },
  connecting: { label: 'Recognizer starting', tone: 'warning' },
  ready: { label: 'Recognizer ready', tone: 'success' },
  error: { label: 'Recognizer error', tone: 'danger' },
};

const BACKEND: Record<Exclude<BackendStatus, 'disabled'>, { label: string; tone: StatusTone }> = {
  checking: { label: 'Connecting to AI…', tone: 'warning' },
  online: { label: 'AI online', tone: 'success' },
  degraded: { label: 'AI not configured', tone: 'warning' },
  offline: { label: 'AI offline', tone: 'danger' },
};

export function TopBar({ screen, onEnterFocus }: { screen: ScreenId; onEnterFocus: () => void }) {
  const { cameraOn, session, speech, captions, captureToNotes, backend } = useSignFlow();
  const meta = SCREENS[screen];
  const model = RECOGNIZER[session.recognizerStatus.state];
  const ai = backend.health.status === 'disabled' ? null : BACKEND[backend.health.status];

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h2 id="screen-title">{meta.title}</h2>
        <p className="topbar-subtitle">{meta.subtitle}</p>
      </div>

      <div className="topbar-status" role="group" aria-label="Status">
        <StatusPill tone={cameraOn ? 'live' : 'neutral'} pulse={cameraOn} data-testid="status-camera">
          {cameraOn ? 'Camera on' : 'Camera off'}
        </StatusPill>
        <StatusPill
          tone={model.tone}
          title={session.recognizerSimulated ? `${session.recognizerName}: scripted signs, not real recognition` : session.recognizerName}
        >
          {model.label}
          {session.recognizerSimulated ? ' · simulated' : ''}
        </StatusPill>
        {ai && (
          <StatusPill
            tone={ai.tone}
            pulse={backend.health.status === 'checking'}
            title={backend.health.error ?? backend.client.baseUrl}
            data-testid="status-backend"
          >
            {ai.label}
          </StatusPill>
        )}
        {captureToNotes && <StatusPill tone="accent">Capturing to notes</StatusPill>}
        {speech.state !== 'idle' && (
          <span className="topbar-speaking">
            <StatusPill tone="accent" pulse={speech.state === 'speaking'} data-testid="status-speaking">
              {speech.state === 'paused' ? 'Speech paused' : 'Speaking'}
            </StatusPill>
            <IconButton icon="stop" label="Stop speaking" size="sm" onClick={speech.stop} />
          </span>
        )}
      </div>

      <div className="topbar-actions">
        <IconButton
          icon="captions"
          label={captions.visible ? 'Hide floating captions' : 'Show floating captions'}
          aria-pressed={captions.visible}
          onClick={() => void captions.toggle()}
          data-testid="captions-toggle"
        />
        <IconButton icon="focus" label={`Focus Mode (${shortcutLabel('Mod+Shift+F')})`} onClick={onEnterFocus} data-testid="focus-enter" />
      </div>
    </header>
  );
}
