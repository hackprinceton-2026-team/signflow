import type { SpeechController } from '../hooks/useSpeech';

interface Props {
  speech: SpeechController;
  autoSpeak: boolean;
  onAutoSpeakChange: (value: boolean) => void;
  /** Text "Speak last" replays (the latest confirmed sentence). */
  lastText: string | undefined;
}

const STATE_LABEL = { idle: 'Idle', speaking: 'Speaking', paused: 'Paused' } as const;

export function SpeechControls({ speech, autoSpeak, onAutoSpeakChange, lastText }: Props) {
  const { state, options, voices } = speech;

  return (
    <section className="panel speech-panel" aria-labelledby="speech-title">
      <div className="panel-head">
        <h2 id="speech-title" className="panel-title">
          Text to speech
        </h2>
        <span className={`pill speech-state speech-${state}`} role="status" data-testid="speech-state">
          {STATE_LABEL[state]}
        </span>
      </div>

      {!speech.available && <p className="inline-alert">Speech synthesis isn&apos;t available on this system.</p>}

      <div className="speech-transport">
        <button
          type="button"
          className="btn"
          onClick={() => lastText && speech.speak(lastText)}
          disabled={!lastText || !speech.available}
        >
          ▶ Speak last
        </button>
        {state === 'paused' ? (
          <button type="button" className="btn" onClick={speech.resume}>
            Resume
          </button>
        ) : (
          <button type="button" className="btn" onClick={speech.pause} disabled={state !== 'speaking'}>
            Pause
          </button>
        )}
        <button type="button" className="btn" onClick={speech.stop} disabled={state === 'idle'}>
          Stop
        </button>
        <label className="toggle">
          <input type="checkbox" checked={autoSpeak} onChange={(e) => onAutoSpeakChange(e.target.checked)} />
          <span>Auto-speak on confirm</span>
        </label>
      </div>

      <div className="speech-grid">
        <label className="field field-wide">
          <span>Voice</span>
          <select
            value={options.voiceId ?? ''}
            onChange={(e) => speech.updateOptions({ voiceId: e.target.value || undefined })}
          >
            <option value="">System default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </label>
        <Slider label="Rate" min={0.5} max={2} step={0.1} value={options.rate} unit="×" onChange={(rate) => speech.updateOptions({ rate })} />
        <Slider label="Pitch" min={0} max={2} step={0.1} value={options.pitch} onChange={(pitch) => speech.updateOptions({ pitch })} />
        <Slider
          label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={options.volume}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(volume) => speech.updateOptions({ volume })}
        />
        <button type="button" className="btn btn-sm reset-btn" onClick={speech.resetOptions}>
          Reset
        </button>
      </div>
    </section>
  );
}

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

function Slider({ label, min, max, step, value, unit = '', format, onChange }: SliderProps) {
  const text = format ? format(value) : `${value.toFixed(1)}${unit}`;
  return (
    <label className="field">
      <span>
        {label} <span className="field-value">{text}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={text}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
