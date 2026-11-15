import { useRef, type KeyboardEvent, type RefObject } from 'react';
import type { ActiveDraft, DraftStatus } from '../state/session';
import { Button, ConfidenceMeter, formatPercent, Icon, Kbd } from '../ui';

export interface DraftOverlayProps {
  draft: ActiveDraft | null;
  status: DraftStatus;
  error: string | null;
  threshold: number;
  /** Show the "sign, then pause" hint when idle (stage variant only). */
  showHint?: boolean;
  canRetry: boolean;
  /** False when no speech engine is available. */
  canSpeak: boolean;
  /** "stage": floats over the camera. "dock": pinned to the bottom of other screens. */
  variant?: 'stage' | 'dock';
  onEdit: (text: string) => void;
  onConfirm: () => void;
  onSpeak: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  /** Lets callers (e.g. a keyboard shortcut) focus the editable text. */
  textRef?: RefObject<HTMLTextAreaElement | null>;
  /** Live mode: offer to finish this phrase in demo mode after a backend failure. */
  onUseDemo?: (() => void) | undefined;
}

/**
 * The English draft, awaiting the user's decision.
 * Confirm commits the text; Speak commits it and reads it aloud. Unconfirmed
 * text is never spoken. The text is directly editable (Edit focuses it).
 */
export function DraftOverlay({
    draft,
    status,
    error,
    threshold,
    showHint = false,
    canRetry,
    canSpeak,
    variant = 'stage',
    onEdit,
    onConfirm,
    onSpeak,
    onDiscard,
    onRetry,
    onDismissError,
    textRef: externalRef,
    onUseDemo,
}: DraftOverlayProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textRef = externalRef ?? ownRef;
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) {
        if (canSpeak) onSpeak();
      } else onConfirm();
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

  const focusText = () => {
    const el = textRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  if (status === 'error' && error) {
    return (
      <div className={`draft draft-${variant} draft-error`} role="alert">
        <Icon name="alert" size={18} />
        <p className="draft-error-text">Translation failed: {error}</p>
        <div className="draft-error-actions">
          <Button size="sm" icon="retry" onClick={onRetry} disabled={!canRetry}>
            Retry
          </Button>
          {onUseDemo && (
            <Button size="sm" variant="ghost" onClick={onUseDemo}>
              Use demo mode
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDismissError}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  if (!draft) {
    if (status === 'translating') {
      return (
        <div className={`draft-pill draft-pill-${variant}`} role="status">
          <span className="ui-spinner" aria-hidden="true" />
          Translating…
        </div>
      );
    }
    if (showHint) {
      return (
        <div className={`draft-pill draft-pill-${variant} draft-hint`} data-testid="draft-empty">
          <Icon name="sparkle" size={14} />
          Sign a phrase, then pause. Your English draft appears here.
        </div>
      );
    }
    return null;
  }

  const empty = !draft.text.trim();
  return (
    <section className={`draft draft-${variant}`} aria-label="English draft" data-testid="draft">
      <p className="sr-only" aria-live="polite">
        Draft ready: {draft.draft.text}
      </p>
      <div className="draft-meta">
        <span className="eyebrow">Draft</span>
        <span className="draft-conf tabular" title="Translation confidence">
          <ConfidenceMeter confidence={draft.draft.confidence} threshold={threshold} size="sm" label="Draft confidence" />
          {formatPercent(draft.draft.confidence)}
        </span>
        <span className="draft-glosses mono" title="Recognized signs">
          {draft.draft.glosses.join(' · ')}
        </span>
        {draft.edited && <span className="draft-badge">Edited</span>}
        {status === 'translating' && (
          <span className="draft-more" role="status">
            <span className="ui-spinner" aria-hidden="true" /> adding…
          </span>
        )}
      </div>

      <label className="sr-only" htmlFor={`draft-text-${variant}`}>
        Draft text (edit before confirming)
      </label>
      <textarea
        id={`draft-text-${variant}`}
        ref={textRef}
        className="draft-text"
        value={draft.text}
        onChange={(e) => onEdit(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        spellCheck
        data-testid="draft-text"
      />

      <div className="draft-actions">
        <Button variant="primary" icon="check" onClick={onConfirm} disabled={empty} shortcut={<Kbd combo="Mod+Enter" />}>
          Confirm
        </Button>
        <Button
          icon="speaker"
          onClick={onSpeak}
          disabled={empty || !canSpeak}
          title={canSpeak ? 'Confirm and speak aloud' : 'Speech is unavailable on this system'}
          shortcut={<Kbd combo="Mod+Shift+Enter" />}
        >
          Speak
        </Button>
        <Button variant="ghost" icon="edit" onClick={focusText}>
          Edit
        </Button>
        <span className="draft-spacer" />
        <Button variant="danger" icon="close" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </section>
  );
}
