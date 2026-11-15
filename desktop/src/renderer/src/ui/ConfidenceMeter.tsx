export function confidenceLevel(confidence: number, threshold: number): 'high' | 'ok' | 'low' {
  if (confidence < threshold) return 'low';
  return confidence >= 0.85 ? 'high' : 'ok';
}

export function formatPercent(confidence: number): string {
  return `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`;
}

interface Props {
  confidence: number;
  threshold: number;
  label?: string;
  /** Compact variant for chips and overlays. */
  size?: 'sm' | 'md';
}

/** Bar meter with a threshold tick. Exposed as role="meter" with a text value. */
export function ConfidenceMeter({ confidence, threshold, label = 'Confidence', size = 'md' }: Props) {
  const level = confidenceLevel(confidence, threshold);
  const pct = Math.round(Math.min(1, Math.max(0, confidence)) * 100);
  return (
    <div
      className={`ui-meter ui-meter-${level} ui-meter-${size}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct} percent${level === 'low' ? ', below threshold' : ''}`}
    >
      <div className="ui-meter-fill" style={{ width: `${pct}%` }} />
      <div className="ui-meter-threshold" style={{ left: `${Math.round(threshold * 100)}%` }} aria-hidden="true" />
    </div>
  );
}
