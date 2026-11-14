import { useEffect, useState } from 'react';
import type { NotesController } from '../hooks/useNotes';
import { noteToMarkdown, wordCount } from '../state/notes';

interface Props {
  notes: NotesController;
}

type Flash = { kind: 'ok' | 'error'; text: string } | null;

export function NotesPanel({ notes }: Props) {
  const { state, current } = notes;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const copy = async () => {
    try {
      await window.signflow.clipboard.writeText(noteToMarkdown(current));
      setFlash({ kind: 'ok', text: 'Copied to clipboard' });
    } catch {
      setFlash({ kind: 'error', text: 'Could not copy' });
    }
  };

  const exportMd = async () => {
    try {
      const res = await window.signflow.notes.exportMarkdown({
        suggestedName: current.title,
        content: noteToMarkdown(current),
      });
      if (res.saved) setFlash({ kind: 'ok', text: `Saved ${res.fileName ?? ''}`.trim() });
    } catch {
      setFlash({ kind: 'error', text: 'Export failed' });
    }
  };

  const empty = !current.body.trim();

  return (
    <section className="panel notes-panel" aria-labelledby="notes-title">
      <div className="panel-head">
        <h2 id="notes-title" className="panel-title">
          Notes
        </h2>
        <div className="panel-actions">
          <label className="toggle toggle-sm">
            <input
              type="checkbox"
              checked={state.timestamps}
              onChange={(e) => notes.setTimestamps(e.target.checked)}
            />
            <span>Timestamps</span>
          </label>
          <button type="button" className="btn btn-sm" onClick={() => void copy()} disabled={empty}>
            Copy
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void exportMd()} disabled={empty}>
            Export .md
          </button>
        </div>
      </div>

      <div className="notes-layout">
        <nav className="notes-list" aria-label="Notes">
          <button type="button" className="btn btn-sm notes-new" onClick={notes.create}>
            + New note
          </button>
          <ul>
            {state.notes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={`notes-item ${n.id === current.id ? 'active' : ''}`}
                  aria-current={n.id === current.id ? 'true' : undefined}
                  onClick={() => {
                    setConfirmingDelete(false);
                    notes.select(n.id);
                  }}
                >
                  <span className="notes-item-title">{n.title || 'Untitled'}</span>
                  <span className="notes-item-meta">{wordCount(n.body)} words</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="notes-editor">
          <div className="notes-title-row">
            <label className="sr-only" htmlFor="note-title">
              Note title
            </label>
            <input
              id="note-title"
              className="notes-title-input"
              value={current.title}
              onChange={(e) => notes.rename(current.id, e.target.value)}
              placeholder="Untitled"
            />
            {confirmingDelete ? (
              <span className="confirm-delete">
                <span>Delete this note?</span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    notes.remove(current.id);
                    setConfirmingDelete(false);
                  }}
                >
                  Delete
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmingDelete(true)}>
                Delete…
              </button>
            )}
          </div>
          <label className="sr-only" htmlFor="note-body">
            Note body
          </label>
          <textarea
            id="note-body"
            className="notes-body"
            value={current.body}
            onChange={(e) => notes.edit(current.id, e.target.value)}
            placeholder="Confirmed sentences are added here. You can also type."
            data-testid="note-body"
          />
          <div className="notes-footer muted">
            <span>{wordCount(current.body)} words · saved locally</span>
            {flash && (
              <span className={`flash flash-${flash.kind}`} role="status">
                {flash.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
