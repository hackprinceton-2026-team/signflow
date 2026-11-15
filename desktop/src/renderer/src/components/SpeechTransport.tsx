import type { SpeechController } from '../hooks/useSpeech';
import { Button, Card, StatusPill } from '../ui';

const STATE = {
  idle: { label: 'Idle', tone: 'neutral' },
  speaking: { label: 'Speaking', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warning' },
} as const;

/** Playback controls for confirmed text (voice settings live in Settings). */
export function SpeechTransport({ speech, lastText }: { speech: SpeechController; lastText: string | undefined }) {
  const { state } = speech;
  const voice = speech.voices.find((v) => v.id === speech.options.voiceId);
  return (
    <Card
      title="Speech"
      subtitle={speech.available ? (voice ? `${voice.name} · ${voice.lang}` : 'System default voice') : 'Unavailable on this system'}
      actions={
        <StatusPill tone={STATE[state].tone} pulse={state === 'speaking'} role="status" data-testid="speech-state">
          {STATE[state].label}
        </StatusPill>
      }
    >
      <div className="transport">
        <Button
          variant="primary"
          icon="play"
          onClick={() => lastText && speech.speak(lastText)}
          disabled={!lastText || !speech.available}
        >
          Speak last
        </Button>
        {state === 'paused' ? (
          <Button icon="play" onClick={speech.resume}>
            Resume
          </Button>
        ) : (
          <Button icon="pause" onClick={speech.pause} disabled={state !== 'speaking'}>
            Pause
          </Button>
        )}
        <Button variant="ghost" icon="stop" onClick={speech.stop} disabled={state === 'idle'}>
          Stop
        </Button>
      </div>
    </Card>
  );
}
