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
}

export function ConfidenceMeter({ confidence, threshold, label = 'Confidence' }: Props) {
  const level = confidenceLevel(confidence, threshold);
  const pct = Math.round(Math.min(1, Math.max(0, confidence)) * 100);
  return (
    <div
      className={`meter meter-${level}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct} percent`}
    >
      <div className="meter-fill" style={{ width: `${pct}%` }} />
      <div className="meter-threshold" style={{ left: `${Math.round(threshold * 100)}%` }} aria-hidden="true" />
    </div>
  );
}
