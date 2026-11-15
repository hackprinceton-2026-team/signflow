import { CLOUD_VOICES, cloudEngineLabel, resolveCloudVoice } from '../adapters/remote/cloudSpeech';
import { pickSystemVoice } from '../adapters/speech';
import type { SpeechVoice, VoiceInUse } from '../adapters/types';
import type { SpeechController } from '../hooks/useSpeech';
import { Button, RangeField, Segmented, SelectField, StatusPill, Switch, type StatusTone } from '../ui';

export const TEST_PHRASE = 'This is how SignFlow will sound.';

/** What the backend says about speech, when the cloud voice is selected. */
export type CloudSpeechStatus = 'ready' | 'not_configured' | 'offline' | 'unknown';

interface Props {
  speech: SpeechController;
  autoSpeak: boolean;
  onAutoSpeakChange: (value: boolean) => void;
  /** Live mode with the cloud voice selected (Settings › Connection). */
  cloudVoice?: boolean;
  cloudStatus?: CloudSpeechStatus;
  /** `process.platform` of the app, to name the system voice ("macOS voice"). */
  platform?: string | undefined;
}

interface Indicator {
  tone: StatusTone;
  label: string;
  detail: string;
}

/** The voice that is (or will be) used, from what last spoke and the current settings. */
export function describeVoiceInUse(opts: {
  cloudVoice: boolean;
  cloudStatus: CloudSpeechStatus;
  cloudVoiceId: string | undefined;
  systemVoice: SpeechVoice | undefined;
  systemLabel: string;
  last: VoiceInUse | null;
}): Indicator {
  const { cloudVoice, cloudStatus, systemVoice, systemLabel, last } = opts;
  const cloud = resolveCloudVoice(opts.cloudVoiceId);
  const systemName = systemVoice?.name ?? 'System default';
  const systemId = systemVoice?.id ?? '';

  // What actually spoke last, if it still matches the current settings.
  if (last && cloudVoice && last.source === 'cloud' && last.id === cloud.id) {
    const generative = last.engine === 'generative';
    return {
      tone: generative ? 'success' : 'warning',
      label: `${last.name} · ${cloudEngineLabel(last.engine)}`,
      detail: generative
        ? 'Last confirmed text was spoken with this cloud voice.'
        : `This voice isn't available with Generative here, so the backend used ${cloudEngineLabel(last.engine)}.`,
    };
  }
  if (last && cloudVoice && last.fallback && last.id === systemId) {
    return {
      tone: 'warning',
      label: `${last.name} · ${systemLabel}`,
      detail: `The cloud voice was unavailable last time, so the ${systemLabel} spoke instead. ${cloud.name} is tried again each time.`,
    };
  }
  if (last && !cloudVoice && last.source === 'system' && !last.fallback && last.id === systemId) {
    return { tone: 'success', label: `${last.name} · ${systemLabel}`, detail: 'Last confirmed text was spoken with this voice.' };
  }

  // Nothing spoken yet with these settings: what will be used.
  if (!cloudVoice) {
    return { tone: 'neutral', label: `${systemName} · ${systemLabel}`, detail: 'Speaks on this device, no network needed.' };
  }
  if (cloudStatus === 'not_configured' || cloudStatus === 'offline') {
    return {
      tone: 'warning',
      label: `${systemName} · ${systemLabel}`,
      detail:
        cloudStatus === 'offline'
          ? `The backend is offline, so the ${systemLabel} will speak until it's back.`
          : `The backend has no AWS credentials for the cloud voice, so the ${systemLabel} will speak.`,
    };
  }
  return {
    tone: 'accent',
    label: `${cloud.name} · ${cloudEngineLabel('generative')}`,
    detail: `Through the SignFlow backend. If it's unavailable, ${systemName} (${systemLabel}) speaks instead.`,
  };
}

/** Voice and playback settings. "Test voice" speaks a fixed phrase, never user text. */
export function SpeechSettings({ speech, autoSpeak, onAutoSpeakChange, cloudVoice = false, cloudStatus = 'unknown', platform }: Props) {
  const { options, voices } = speech;
  const systemLabel = platform === 'darwin' ? 'macOS voice' : 'system voice';
  const systemVoice = pickSystemVoice(voices, options.voiceId);
  const cloud = resolveCloudVoice(options.cloudVoiceId);
  const indicator = describeVoiceInUse({
    cloudVoice,
    cloudStatus,
    cloudVoiceId: options.cloudVoiceId,
    systemVoice,
    systemLabel,
    last: speech.voiceInUse,
  });

  return (
    <div className="settings-stack">
      {!speech.available && (
        <p className="inline-alert" role="alert">
          Speech synthesis isn&apos;t available on this system. Confirmed text still goes to captions and notes.
        </p>
      )}
      <div className="voice-in-use" data-testid="voice-in-use">
        <span className="setting-line-text">
          <span className="setting-line-label">Voice in use</span>
          <StatusPill tone={indicator.tone} data-testid="voice-in-use-pill">
            {indicator.label}
          </StatusPill>
        </span>
        <p className="backend-hint">{indicator.detail}</p>
      </div>
      <Switch
        checked={autoSpeak}
        onChange={onAutoSpeakChange}
        label="Speak when confirming"
        description="Off: only the Speak action reads text aloud. Unconfirmed drafts are never spoken."
      />
      {cloudVoice ? (
        <div className="cloud-voice-picker">
          <Segmented
            label="Cloud voice"
            value={cloud.id}
            options={CLOUD_VOICES.map((v) => ({ value: v.id, label: v.name }))}
            onChange={(cloudVoiceId) => speech.updateOptions({ cloudVoiceId })}
          />
          <p className="subtle" data-testid="cloud-voice-detail">
            {cloud.name}: {cloud.description} · {cloudEngineLabel('generative')}
          </p>
        </div>
      ) : (
        <p className="subtle">
          More natural, human-like voices (Amazon Polly Generative: Ruth, Danielle, Matthew) are available in Live mode: choose
          Cloud voice under Connection.
        </p>
      )}
      <SelectField
        label={cloudVoice ? 'Fallback voice' : 'System voice'}
        value={options.voiceId && voices.some((v) => v.id === options.voiceId) ? options.voiceId : ''}
        options={[
          { value: '', label: `Automatic (${systemVoice ? systemVoice.name : 'system default'})` },
          ...voices.map((v) => ({ value: v.id, label: `${v.name} (${v.lang})` })),
        ]}
        onChange={(id) => speech.updateOptions({ voiceId: id || undefined })}
      />
      {cloudVoice && (
        <p className="subtle">Speaks on this device, with the same confirmed text, whenever the cloud voice is unavailable.</p>
      )}
      <div className="settings-grid-3">
        <RangeField label="Rate" value={options.rate} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(rate) => speech.updateOptions({ rate })} />
        <RangeField
          label="Pitch"
          value={options.pitch}
          min={0}
          max={2}
          step={0.1}
          format={(v) => (cloudVoice ? 'n/a' : v.toFixed(1))}
          description={cloudVoice ? 'Not supported by the cloud voice.' : undefined}
          onChange={(pitch) => speech.updateOptions({ pitch })}
        />
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
        <Button icon="speaker" onClick={() => speech.preview(TEST_PHRASE)} disabled={!speech.available}>
          Test voice
        </Button>
        <Button variant="ghost" icon="retry" onClick={speech.resetOptions}>
          Reset
        </Button>
      </div>
    </div>
  );
}
