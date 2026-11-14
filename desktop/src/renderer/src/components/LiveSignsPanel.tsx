import type { RecognizedSign } from '../adapters/types';
import { isAccepted, type SessionSettings } from '../state/session';
import { ConfidenceMeter, confidenceLevel, formatPercent } from './ConfidenceMeter';

interface Props {
  liveSigns: RecognizedSign[];
  buffer: RecognizedSign[];
  settings: SessionSettings;
  translating: boolean;
  onThresholdChange: (value: number) => void;
  onClearBuffer: () => void;
  onTranslateNow: () => void;
}

function signState(sign: RecognizedSign, settings: SessionSettings): 'provisional' | 'accepted' | 'rejected' {
  if (!sign.final) return 'provisional';
  return isAccepted(sign, settings) ? 'accepted' : 'rejected';
}

const STATE_LABEL = { provisional: 'refining', accepted: 'accepted', rejected: 'low confidence' } as const;

export function LiveSignsPanel({
  liveSigns,
  buffer,
  settings,
  translating,
  onThresholdChange,
  onClearBuffer,
  onTranslateNow,
}: Props) {
  const threshold = settings.minConfidence;

  return (
    <section className="panel live-panel" aria-labelledby="live-title">
      <div className="panel-head">
        <h2 id="live-title" className="panel-title">
          Live signs
        </h2>
        <label className="threshold">
          <span>Min confidence</span>
          <input
            type="range"
            min={0.3}
            max={0.95}
            step={0.05}
            value={threshold}
            onChange={(e) => onThresholdChange(Number(e.target.value))}
            aria-valuetext={formatPercent(threshold)}
          />
          <span className="threshold-value">{formatPercent(threshold)}</span>
        </label>
      </div>

      <div className="phrase" aria-live="polite" data-testid="phrase-buffer">
        <span className="phrase-label">Current phrase</span>
        <div className="phrase-glosses">
          {buffer.length === 0 ? (
            <span className="muted">{translating ? 'Translating…' : 'Waiting for signs…'}</span>
          ) : (
            buffer.map((s) => (
              <span key={s.id} className="gloss-tag">
                {s.gloss}
              </span>
            ))
          )}
        </div>
        <div className="phrase-actions">
          <button type="button" className="btn btn-sm" onClick={onTranslateNow} disabled={buffer.length === 0 || translating}>
            Translate now
          </button>
          <button type="button" className="btn btn-sm" onClick={onClearBuffer} disabled={buffer.length === 0}>
            Clear
          </button>
        </div>
      </div>

      {liveSigns.length === 0 ? (
        <p className="muted empty">Recognized signs will stream here with their confidence.</p>
      ) : (
        <ol className="sign-feed" aria-label="Recognized signs, newest first">
          {liveSigns.map((sign) => {
            const st = signState(sign, settings);
            return (
              <li key={sign.id} className={`sign-row sign-${st}`} data-testid="sign-row">
                <span className="sign-gloss">{sign.gloss}</span>
                <ConfidenceMeter confidence={sign.confidence} threshold={threshold} label={`${sign.gloss} confidence`} />
                <span className={`sign-pct conf-${confidenceLevel(sign.confidence, threshold)}`}>
                  {formatPercent(sign.confidence)}
                </span>
                <span className="sign-state">{STATE_LABEL[st]}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
