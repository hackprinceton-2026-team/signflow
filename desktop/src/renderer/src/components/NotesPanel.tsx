import { useEffect, useState, type ReactNode } from 'react';
import type { NotesController } from '../hooks/useNotes';
import { noteToMarkdown, wordCount } from '../state/notes';
import { Button, Icon, IconButton, Switch } from '../ui';

interface Props {
  notes: NotesController;
  /** Extra controls shown in the editor toolbar (e.g. "Capture from Live"). */
  toolbar?: ReactNode;
}

type Flash = { kind: 'ok' | 'error'; text: string } | null;

function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function NotesPanel({ notes, toolbar }: Props) {
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
    <section className="notes" aria-label="Notes">
      <nav className="notes-list" aria-label="All notes">
        <div className="notes-list-head">
          <span className="eyebrow">Notes</span>
          <Button size="sm" icon="plus" onClick={notes.create}>
            New note
          </Button>
        </div>
        <ul>
          {state.notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`notes-item ${n.id === current.id ? 'is-active' : ''}`}
                aria-current={n.id === current.id ? 'true' : undefined}
                onClick={() => {
                  setConfirmingDelete(false);
                  notes.select(n.id);
                }}
              >
                <span className="notes-item-title">{n.title || 'Untitled'}</span>
                <span className="notes-item-meta tabular">
                  {wordCount(n.body)} words · {relativeTime(n.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="notes-editor">
        <div className="notes-toolbar">
          {toolbar}
          <Switch checked={state.timestamps} onChange={notes.setTimestamps} label="Timestamps" />
          <span className="notes-toolbar-spacer" />
          <Button size="sm" icon="copy" onClick={() => void copy()} disabled={empty}>
            Copy
          </Button>
          <Button size="sm" icon="download" onClick={() => void exportMd()} disabled={empty}>
            Export .md
          </Button>
        </div>

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
            <span className="confirm-delete" role="group" aria-label="Confirm delete">
              <span>Delete this note?</span>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  notes.remove(current.id);
                  setConfirmingDelete(false);
                }}
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <IconButton icon="trash" label="Delete…" onClick={() => setConfirmingDelete(true)} />
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
        <div className="notes-footer">
          <span className="subtle tabular">
            {wordCount(current.body)} words · <Icon name="shield" size={12} /> saved on this device
          </span>
          {flash && (
            <span className={`flash flash-${flash.kind}`} role="status">
              {flash.text}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
