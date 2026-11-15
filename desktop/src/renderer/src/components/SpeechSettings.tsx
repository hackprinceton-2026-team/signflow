import { KOKORO_INSTALL_COMMAND, KOKORO_MODEL_BYTES, KOKORO_VOICES, resolveKokoroVoice, type KokoroStatus } from '@shared/kokoro';
import { KOKORO_ENGINE_LABEL } from '../adapters/kokoroSpeech';
import { CLOUD_VOICES, cloudEngineLabel, resolveCloudVoice } from '../adapters/remote/cloudSpeech';
import { pickSystemVoice } from '../adapters/speech';
import type { SpeechVoice, VoiceInUse } from '../adapters/types';
import type { DeviceSpeechEngine } from '../app/useSignFlow';
import type { KokoroController } from '../hooks/useKokoro';
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
  /** The on-device engine: system voices or Kokoro. */
  engine?: DeviceSpeechEngine;
  onEngineChange?: (engine: DeviceSpeechEngine) => void;
  /** Kokoro status and controls (absent outside Electron). */
  kokoro?: (KokoroController & { available: boolean }) | undefined;
}

interface Indicator {
  tone: StatusTone;
  label: string;
  detail: string;
}

/** Kokoro will (try to) speak: it's selected and not known to be broken or missing. */
function kokoroUsable(engine: DeviceSpeechEngine, status: KokoroStatus | null): boolean {
  return engine === 'kokoro' && status?.state !== 'missing' && status?.state !== 'error';
}

/** The voice that is (or will be) used, from what last spoke and the current settings. */
export function describeVoiceInUse(opts: {
  cloudVoice: boolean;
  cloudStatus: CloudSpeechStatus;
  cloudVoiceId: string | undefined;
  systemVoice: SpeechVoice | undefined;
  systemLabel: string;
  last: VoiceInUse | null;
  engine?: DeviceSpeechEngine;
  kokoroVoiceId?: string | undefined;
  kokoroStatus?: KokoroStatus | null;
}): Indicator {
  const { cloudVoice, cloudStatus, systemVoice, systemLabel, last, engine = 'system', kokoroStatus = null } = opts;
  const cloud = resolveCloudVoice(opts.cloudVoiceId);
  const kokoroVoice = resolveKokoroVoice(opts.kokoroVoiceId);
  const kokoro = engine === 'kokoro';
  const kokoroLabel = `${kokoroVoice.name} · ${KOKORO_ENGINE_LABEL}`;
  const systemName = systemVoice?.name ?? 'System default';
  const systemId = systemVoice?.id ?? '';
  const useKokoro = kokoroUsable(engine, kokoroStatus);
  /** The on-device voice that speaks (directly, or when the cloud voice is unavailable). */
  const device = useKokoro
    ? { label: kokoroLabel, name: `${kokoroVoice.name} (Kokoro)`, short: 'Kokoro' }
    : { label: `${systemName} · ${systemLabel}`, name: `${systemName} (${systemLabel})`, short: `the ${systemLabel}` };

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
  if (last && kokoro && last.source === 'kokoro' && last.id === kokoroVoice.id) {
    if (cloudVoice && last.fallback) {
      return {
        tone: 'warning',
        label: kokoroLabel,
        detail: `The cloud voice was unavailable last time, so Kokoro spoke instead. ${cloud.name} is tried again each time.`,
      };
    }
    if (!cloudVoice) {
      return { tone: 'success', label: kokoroLabel, detail: 'Last confirmed text was spoken with this voice, entirely on this device.' };
    }
  }
  if (last && last.source === 'system' && last.fallback && last.id === systemId && (cloudVoice || kokoro)) {
    return {
      tone: 'warning',
      label: `${last.name} · ${systemLabel}`,
      detail: kokoro
        ? `Kokoro was unavailable last time, so the ${systemLabel} spoke instead. Kokoro is tried again each time.`
        : `The cloud voice was unavailable last time, so the ${systemLabel} spoke instead. ${cloud.name} is tried again each time.`,
    };
  }
  if (last && !cloudVoice && !kokoro && last.source === 'system' && !last.fallback && last.id === systemId) {
    return { tone: 'success', label: `${last.name} · ${systemLabel}`, detail: 'Last confirmed text was spoken with this voice.' };
  }

  // Nothing spoken yet with these settings: what will be used.
  if (!cloudVoice && kokoro) {
    if (kokoroStatus?.state === 'missing') {
      return { tone: 'warning', label: device.label, detail: `Kokoro isn't installed yet, so the ${systemLabel} will speak.` };
    }
    if (kokoroStatus?.state === 'error') {
      return { tone: 'warning', label: device.label, detail: `Kokoro isn't working right now, so the ${systemLabel} will speak.` };
    }
    return {
      tone: 'accent',
      label: kokoroLabel,
      detail:
        kokoroStatus?.state === 'ready'
          ? 'Runs entirely on this device. No network needed.'
          : 'Loading the voice model. Runs entirely on this device.',
    };
  }
  if (!cloudVoice) {
    return { tone: 'neutral', label: `${systemName} · ${systemLabel}`, detail: 'Speaks on this device, no network needed.' };
  }
  if (cloudStatus === 'not_configured' || cloudStatus === 'offline') {
    return {
      tone: 'warning',
      label: device.label,
      detail:
        cloudStatus === 'offline'
          ? `The backend is offline, so ${device.short} will speak until it's back.`
          : `The backend has no AWS credentials for the cloud voice, so ${device.short} will speak.`,
    };
  }
  return {
    tone: 'accent',
    label: `${cloud.name} · ${cloudEngineLabel('generative')}`,
    detail: `Through the SignFlow backend. If it's unavailable, ${device.name} speaks instead.`,
  };
}

const KOKORO_PILL: Record<KokoroStatus['state'], { tone: StatusTone; label: string }> = {
  missing: { tone: 'warning', label: 'Not installed' },
  installed: { tone: 'neutral', label: 'Installed · loads on first use' },
  loading: { tone: 'warning', label: 'Loading model…' },
  ready: { tone: 'success', label: 'Ready' },
  error: { tone: 'danger', label: 'Unavailable' },
};

const MODEL_MB = Math.round(KOKORO_MODEL_BYTES / 1_000_000);

/** Kokoro's install/readiness state, voice picker, and recovery actions. */
function KokoroPanel({ kokoro, speech, systemLabel }: { kokoro: NonNullable<Props['kokoro']>; speech: SpeechController; systemLabel: string }) {
  const { status } = kokoro;
  const voice = resolveKokoroVoice(speech.options.kokoroVoiceId);
  const pill = status ? KOKORO_PILL[status.state] : { tone: 'neutral' as const, label: 'Checking…' };
  return (
    <div className="kokoro-panel" data-testid="kokoro-panel">
      <div className="setting-line">
        <span className="setting-line-text">
          <span className="setting-line-label">Kokoro model</span>
          <StatusPill tone={pill.tone} pulse={status?.state === 'loading'} role="status" data-testid="kokoro-status">
            {pill.label}
            {status?.state === 'ready' && status.loadMs !== undefined ? ` · loaded in ${(status.loadMs / 1000).toFixed(1)} s` : ''}
          </StatusPill>
        </span>
        {(status?.state === 'missing' || status?.state === 'error' || status?.state === 'installed') && (
          <Button size="sm" icon="retry" onClick={() => void kokoro.prepare()}>
            {status.state === 'installed' ? 'Load now' : 'Check again'}
          </Button>
        )}
      </div>
      {status?.state === 'missing' && (
        <p className="backend-hint" data-testid="kokoro-hint">
          The Kokoro voice model isn&apos;t installed on this device. Install it once ({MODEL_MB} MB from Hugging Face, checked
          against pinned SHA-256 hashes), then choose Check again: <code>{KOKORO_INSTALL_COMMAND}</code>. Until then, the{' '}
          {systemLabel} speaks.
        </p>
      )}
      {status?.state === 'error' && (
        <p className="backend-hint" data-testid="kokoro-hint">
          {status.message} The {systemLabel} speaks instead.
        </p>
      )}
      {(status?.state === 'ready' || status?.state === 'loading' || status?.state === 'installed') && (
        <p className="backend-hint">Runs entirely on this device with a local copy of Kokoro-82M. Your text never leaves it.</p>
      )}
      <Segmented
        label="Kokoro voice"
        value={voice.id}
        options={KOKORO_VOICES.map((v) => ({ value: v.id, label: v.name }))}
        onChange={(kokoroVoiceId) => speech.updateOptions({ kokoroVoiceId })}
      />
      <p className="subtle" data-testid="kokoro-voice-detail">
        {voice.name}: {voice.description}
      </p>
    </div>
  );
}

/** Voice and playback settings. "Test voice" speaks a fixed phrase, never user text. */
export function SpeechSettings({
  speech,
  autoSpeak,
  onAutoSpeakChange,
  cloudVoice = false,
  cloudStatus = 'unknown',
  platform,
  engine = 'system',
  onEngineChange,
  kokoro,
}: Props) {
  const { options, voices } = speech;
  const kokoroOn = engine === 'kokoro' && kokoro !== undefined;
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
    engine: kokoroOn ? 'kokoro' : 'system',
    kokoroVoiceId: options.kokoroVoiceId,
    kokoroStatus: kokoro?.status ?? null,
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
      {kokoro && onEngineChange && (
        <div className="speech-engine-picker">
          <Segmented
            label="Speech engine"
            value={engine}
            options={[
              { value: 'system', label: 'System voice' },
              { value: 'kokoro', label: 'Kokoro — Local Neural Voice' },
            ]}
            onChange={onEngineChange}
          />
          <p className="subtle">
            {cloudVoice
              ? 'The cloud voice speaks first; this on-device engine speaks whenever it is unavailable.'
              : engine === 'kokoro'
                ? `A natural neural voice that runs on this device, offline. If it can't speak, the ${systemLabel} does.`
                : `Built-in ${systemLabel}s. Kokoro sounds far more natural and also runs entirely on this device.`}
          </p>
        </div>
      )}
      {kokoroOn && <KokoroPanel kokoro={kokoro} speech={speech} systemLabel={systemLabel} />}
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
        label={cloudVoice || kokoroOn ? 'Fallback voice' : 'System voice'}
        value={options.voiceId && voices.some((v) => v.id === options.voiceId) ? options.voiceId : ''}
        options={[
          { value: '', label: `Automatic (${systemVoice ? systemVoice.name : 'system default'})` },
          ...voices.map((v) => ({ value: v.id, label: `${v.name} (${v.lang})` })),
        ]}
        onChange={(id) => speech.updateOptions({ voiceId: id || undefined })}
      />
      {(cloudVoice || kokoroOn) && (
        <p className="subtle">
          Speaks with the same confirmed text whenever the {cloudVoice ? 'cloud' : 'Kokoro'} voice is unavailable.
        </p>
      )}
      <div className="settings-grid-3">
        <RangeField label="Rate" value={options.rate} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(rate) => speech.updateOptions({ rate })} />
        <RangeField
          label="Pitch"
          value={options.pitch}
          min={0}
          max={2}
          step={0.1}
          format={(v) => (cloudVoice || kokoroOn ? 'n/a' : v.toFixed(1))}
          description={cloudVoice ? 'Not supported by the cloud voice.' : kokoroOn ? 'Not supported by Kokoro.' : undefined}
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
