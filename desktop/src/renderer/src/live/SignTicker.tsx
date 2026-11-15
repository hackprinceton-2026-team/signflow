import type { RecognizedSign } from '../adapters/types';
import { ConfidenceMeter, formatPercent } from '../ui';

interface Props {
  buffer: RecognizedSign[];
  /** Newest recognizer event; shown as "refining" while not final. */
  latest: RecognizedSign | undefined;
  threshold: number;
  max?: number;
}

/** The phrase being built, sign by sign, over the camera. */
export function SignTicker({ buffer, latest, threshold, max = 8 }: Props) {
  const provisional = latest && !latest.final ? latest : undefined;
  const shown = buffer.slice(-max);
  if (shown.length === 0 && !provisional) return null;

  return (
    <div className="ticker" role="group" aria-label="Current phrase" data-testid="sign-ticker">
      {shown.map((s) => (
        <span key={s.id} className="chip" data-testid="sign-chip" title={`${s.gloss} · ${formatPercent(s.confidence)}`}>
          <span className="chip-gloss mono">{s.gloss}</span>
          <ConfidenceMeter confidence={s.confidence} threshold={threshold} size="sm" label={`${s.gloss} confidence`} />
        </span>
      ))}
      {provisional && (
        <span key={provisional.id} className="chip chip-provisional" aria-label={`Refining ${provisional.gloss}`}>
          <span className="chip-gloss mono">{provisional.gloss}</span>
          <span className="chip-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </span>
      )}
    </div>
  );
}
