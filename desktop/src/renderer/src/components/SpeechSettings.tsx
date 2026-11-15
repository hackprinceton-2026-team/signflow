import type { SpeechController } from '../hooks/useSpeech';
import { Button, RangeField, SelectField, Switch } from '../ui';

export const TEST_PHRASE = 'This is how SignFlow will sound.';

interface Props {
  speech: SpeechController;
  autoSpeak: boolean;
  onAutoSpeakChange: (value: boolean) => void;
}

/** Voice and playback settings. "Test voice" speaks a fixed phrase, never user text. */
export function SpeechSettings({ speech, autoSpeak, onAutoSpeakChange }: Props) {
  const { options, voices } = speech;
  return (
    <div className="settings-stack">
      {!speech.available && (
        <p className="inline-alert" role="alert">
          Speech synthesis isn&apos;t available on this system. Confirmed text still goes to captions and notes.
        </p>
      )}
      <Switch
        checked={autoSpeak}
        onChange={onAutoSpeakChange}
        label="Speak when confirming"
        description="Off: only the Speak action reads text aloud. Unconfirmed drafts are never spoken."
      />
      <SelectField
        label="Voice"
        value={options.voiceId ?? ''}
        options={[{ value: '', label: 'System default' }, ...voices.map((v) => ({ value: v.id, label: `${v.name} (${v.lang})` }))]}
        onChange={(id) => speech.updateOptions({ voiceId: id || undefined })}
      />
      <div className="settings-grid-3">
        <RangeField label="Rate" value={options.rate} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(rate) => speech.updateOptions({ rate })} />
        <RangeField label="Pitch" value={options.pitch} min={0} max={2} step={0.1} format={(v) => v.toFixed(1)} onChange={(pitch) => speech.updateOptions({ pitch })} />
        <RangeField
          label="Volume"
          value={options.volume}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(volume) => speech.updateOptions({ volume })}
        />
      </div>
      <div className="settings-actions">
        <Button icon="speaker" onClick={() => speech.speak(TEST_PHRASE)} disabled={!speech.available}>
          Test voice
        </Button>
        <Button variant="ghost" icon="retry" onClick={speech.resetOptions}>
          Reset
        </Button>
      </div>
    </div>
  );
}
