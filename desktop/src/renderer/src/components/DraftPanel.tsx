import type { KeyboardEvent } from 'react';
import type { ActiveDraft, DraftStatus } from '../state/session';
import { ConfidenceMeter, formatPercent } from './ConfidenceMeter';

interface Props {
  draft: ActiveDraft | null;
  status: DraftStatus;
  error: string | null;
  threshold: number;
  autoSpeak: boolean;
  canRetry: boolean;
  onEdit: (text: string) => void;
  onConfirm: () => void;
  onDiscard: () => void;
  onPreview: (text: string) => void;
  onRetry: () => void;
  onDismissError: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
export const CONFIRM_SHORTCUT = isMac ? '⌘↵' : 'Ctrl+↵';

export function DraftPanel({
  draft,
  status,
  error,
  threshold,
  autoSpeak,
  canRetry,
  onEdit,
  onConfirm,
  onDiscard,
  onPreview,
  onRetry,
  onDismissError,
}: Props) {
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onConfirm();
    }
  };

  const empty = !draft?.text.trim();

  return (
    <section className="panel draft-panel" aria-labelledby="draft-title">
      <div className="panel-head">
        <h2 id="draft-title" className="panel-title">
          English draft
        </h2>
        {status === 'translating' && (
          <span className="pill pill-info" role="status">
            <span className="spinner" aria-hidden="true" /> Translating…
          </span>
        )}
        {draft?.edited && <span className="pill">Edited</span>}
      </div>

      {status === 'error' && error && (
        <div className="inline-alert" role="alert">
          <span>Translation failed: {error}</span>
          <div className="inline-alert-actions">
            <button type="button" className="btn btn-sm" onClick={onRetry} disabled={!canRetry}>
              Retry
            </button>
            <button type="button" className="btn btn-sm" onClick={onDismissError}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {draft ? (
        <>
          <label className="sr-only" htmlFor="draft-text">
            Draft text (edit before confirming)
          </label>
          <textarea
            id="draft-text"
            className="draft-text"
            value={draft.text}
            onChange={(e) => onEdit(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            spellCheck
            data-testid="draft-text"
          />
          <div className="draft-meta">
            <span className="draft-glosses" title="Recognized signs">
              {draft.draft.glosses.join(' · ')}
            </span>
            <span className="draft-conf">
              <ConfidenceMeter confidence={draft.draft.confidence} threshold={threshold} label="Draft confidence" />
              <span>{formatPercent(draft.draft.confidence)}</span>
            </span>
          </div>
          <div className="draft-actions">
            <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={empty}>
              Confirm{autoSpeak ? ' & speak' : ''} <kbd>{CONFIRM_SHORTCUT}</kbd>
            </button>
            <button type="button" className="btn" onClick={() => onPreview(draft.text)} disabled={empty}>
              Preview voice
            </button>
            <button type="button" className="btn btn-danger" onClick={onDiscard}>
              Discard
            </button>
          </div>
        </>
      ) : (
        <p className="muted empty" data-testid="draft-empty">
          {status === 'translating'
            ? 'Turning your signs into English…'
            : 'Sign a phrase, then pause. Your English draft appears here to review, edit, and confirm.'}
        </p>
      )}
    </section>
  );
}
