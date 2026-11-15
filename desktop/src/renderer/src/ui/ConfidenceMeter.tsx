export function confidenceLevel(confidence: number, threshold: number): 'high' | 'ok' | 'low' {
  if (confidence < threshold) return 'low';
  return confidence >= 0.85 ? 'high' : 'ok';
}

/**
 * Whole percent, truncated (not rounded): a sign at 59.6% is below a 60%
 * threshold and must not be shown as "60%" next to a "low confidence" label.
 */
export function toPercent(confidence: number): number {
  const clamped = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  return Math.floor(clamped * 100 + 1e-9);
}

export function formatPercent(confidence: number): string {
  return `${toPercent(confidence)}%`;
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
  const pct = toPercent(confidence);
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
