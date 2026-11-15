import type { AdapterStatus } from '../adapters/types';
import { IconButton, StatusPill, type StatusTone } from '../ui';
import { shortcutLabel } from '../ui/Kbd';
import { SCREENS, type ScreenId } from './screens';
import { useSignFlow } from './useSignFlow';

const MODEL: Record<AdapterStatus['state'], { label: string; tone: StatusTone }> = {
  idle: { label: 'Model idle', tone: 'neutral' },
  connecting: { label: 'Model connecting', tone: 'warning' },
  ready: { label: 'Model ready', tone: 'success' },
  error: { label: 'Model error', tone: 'danger' },
};

export function TopBar({ screen, onEnterFocus }: { screen: ScreenId; onEnterFocus: () => void }) {
  const { cameraOn, session, speech, captions, captureToNotes } = useSignFlow();
  const meta = SCREENS[screen];
  const model = MODEL[session.recognizerStatus.state];

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
        <StatusPill tone={model.tone} title={session.recognizerName}>
          {model.label}
        </StatusPill>
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
