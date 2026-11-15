import type { RecognizedSign } from '../adapters/types';
import { isAccepted, type SessionSettings } from '../state/session';
import { Button, Card, ConfidenceMeter, confidenceLevel, formatPercent, RangeField } from '../ui';

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

/** Every recognizer event with its confidence, plus the phrase being built. */
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
    <Card title="Live signs" subtitle="Newest first. Signs below the threshold are shown but not used." className="signs-card">
      <div className="phrase" data-testid="phrase-buffer">
        <div className="phrase-head">
          <span className="eyebrow">Current phrase</span>
          <div className="phrase-actions">
            <Button size="sm" icon="sparkle" onClick={onTranslateNow} disabled={buffer.length === 0 || translating}>
              Translate now
            </Button>
            <Button size="sm" variant="ghost" onClick={onClearBuffer} disabled={buffer.length === 0}>
              Clear
            </Button>
          </div>
        </div>
        <div className="phrase-glosses" aria-live="polite">
          {buffer.length === 0 ? (
            <span className="subtle">{translating ? 'Translating…' : 'Waiting for signs…'}</span>
          ) : (
            buffer.map((s) => (
              <span key={s.id} className="gloss-tag mono">
                {s.gloss}
              </span>
            ))
          )}
        </div>
      </div>

      <RangeField
        label="Minimum confidence"
        value={threshold}
        min={0.3}
        max={0.95}
        step={0.05}
        format={formatPercent}
        onChange={onThresholdChange}
      />

      {liveSigns.length === 0 ? (
        <p className="empty-state">Recognized signs will stream here with their confidence.</p>
      ) : (
        <ol className="sign-feed" aria-label="Recognized signs, newest first">
          {liveSigns.map((sign) => {
            const st = signState(sign, settings);
            return (
              <li key={sign.id} className={`sign-row sign-${st}`} data-testid="sign-row">
                <span className="sign-gloss mono">{sign.gloss}</span>
                <ConfidenceMeter confidence={sign.confidence} threshold={threshold} label={`${sign.gloss} confidence`} />
                <span className={`sign-pct tabular conf-${confidenceLevel(sign.confidence, threshold)}`}>
                  {formatPercent(sign.confidence)}
                </span>
                <span className={`sign-state state-${st}`}>{STATE_LABEL[st]}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
