import type { RecognizedSign } from '../adapters/types';
import { formatAlternatives } from '../components/LiveSignsPanel';
import { isAccepted } from '../state/session';
import { ConfidenceMeter, formatPercent } from '../ui';

interface Props {
  buffer: RecognizedSign[];
  /** Newest recognizer event; shown as "refining" while not final. */
  latest: RecognizedSign | undefined;
  threshold: number;
  max?: number;
  /**
   * Also show the newest sign when it was recognized but NOT used (below the
   * threshold, or the model wasn't sure), so a real signer sees that it was
   * seen and dropped instead of nothing happening.
   */
  showRejected?: boolean;
}

/** The phrase being built, sign by sign, over the camera. */
export function SignTicker({ buffer, latest, threshold, max = 8, showRejected = false }: Props) {
  const provisional = latest && !latest.final ? latest : undefined;
  const rejected =
    showRejected && latest?.final && !isAccepted(latest, { minConfidence: threshold, pauseMs: 0, autoSpeak: false }) ? latest : undefined;
  const shown = buffer.slice(-max);
  if (shown.length === 0 && !provisional && !rejected) return null;

  return (
    <div className="ticker" role="group" aria-label="Current phrase" data-testid="sign-ticker">
      {shown.map((s) => (
        <span key={s.id} className="chip" data-testid="sign-chip" title={`${s.gloss} · ${formatPercent(s.confidence)}`}>
          <span className="chip-gloss mono">{s.gloss}</span>
          <ConfidenceMeter confidence={s.confidence} threshold={threshold} size="sm" label={`${s.gloss} confidence`} />
        </span>
      ))}
      {rejected && (
        <span
          key={rejected.id}
          className="chip chip-rejected"
          data-testid="sign-chip-rejected"
          title={`${rejected.gloss} ${formatPercent(rejected.confidence)}: not used${
            formatAlternatives(rejected) ? `. Also possible: ${formatAlternatives(rejected)}` : ''
          }`}
        >
          <span className="chip-gloss mono">{rejected.gloss}?</span>
          <span className="chip-note">
            not used · {rejected.uncertain ? 'model unsure' : formatPercent(rejected.confidence)}
          </span>
        </span>
      )}
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
