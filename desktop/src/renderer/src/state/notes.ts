export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface NotesState {
  notes: Note[];
  activeId: string;
  /** Prefix appended sentences with a [hh:mm] timestamp. */
  timestamps: boolean;
}

export type NotesAction =
  | { type: 'note/created'; id: string; at: number; title?: string }
  | { type: 'note/selected'; id: string }
  | { type: 'note/renamed'; id: string; title: string; at: number }
  | { type: 'note/edited'; id: string; body: string; at: number }
  | { type: 'note/appended'; text: string; at: number; timeLabel: string }
  | { type: 'note/deleted'; id: string; at: number; newId: string }
  | { type: 'timestamps/toggled'; value: boolean };

export function defaultNoteTitle(at: number): string {
  const d = new Date(at);
  return `Notes ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function createNote(id: string, at: number, title = defaultNoteTitle(at)): Note {
  return { id, title, body: '', createdAt: at, updatedAt: at };
}

export function initialNotesState(id: string, at: number): NotesState {
  return { notes: [createNote(id, at)], activeId: id, timestamps: true };
}

export function activeNote(state: NotesState): Note {
  // Invariant: there is always at least one note and activeId points at one.
  return state.notes.find((n) => n.id === state.activeId) ?? (state.notes[0] as Note);
}

function updateNote(state: NotesState, id: string, patch: (n: Note) => Note): NotesState {
  return { ...state, notes: state.notes.map((n) => (n.id === id ? patch(n) : n)) };
}

/** Append a confirmed sentence as its own line. */
export function appendLine(body: string, line: string): string {
  if (!body) return line;
  return body.endsWith('\n') ? `${body}${line}` : `${body}\n${line}`;
}

export function notesReducer(state: NotesState, action: NotesAction): NotesState {
  switch (action.type) {
    case 'note/created': {
      const note = createNote(action.id, action.at, action.title);
      return { ...state, notes: [note, ...state.notes], activeId: note.id };
    }
    case 'note/selected':
      return state.notes.some((n) => n.id === action.id) ? { ...state, activeId: action.id } : state;
    case 'note/renamed':
      return updateNote(state, action.id, (n) => ({ ...n, title: action.title, updatedAt: action.at }));
    case 'note/edited':
      return updateNote(state, action.id, (n) => ({ ...n, body: action.body, updatedAt: action.at }));
    case 'note/appended': {
      const text = action.text.trim();
      if (!text) return state;
      const line = state.timestamps ? `[${action.timeLabel}] ${text}` : text;
      const id = activeNote(state).id;
      return updateNote(state, id, (n) => ({ ...n, body: appendLine(n.body, line), updatedAt: action.at }));
    }
    case 'note/deleted': {
      const remaining = state.notes.filter((n) => n.id !== action.id);
      if (remaining.length === 0) {
        return { ...state, notes: [createNote(action.newId, action.at)], activeId: action.newId };
      }
      const activeId = state.activeId === action.id ? (remaining[0] as Note).id : state.activeId;
      return { ...state, notes: remaining, activeId };
    }
    case 'timestamps/toggled':
      return { ...state, timestamps: action.value };
    default:
      return state;
  }
}

/** Validate persisted state so a corrupt/old localStorage entry can't crash the app. */
export function isNotesState(value: unknown): value is NotesState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['notes']) || v['notes'].length === 0) return false;
  if (typeof v['activeId'] !== 'string' || typeof v['timestamps'] !== 'boolean') return false;
  return v['notes'].every((n: unknown) => {
    if (!n || typeof n !== 'object') return false;
    const o = n as Record<string, unknown>;
    return (
      typeof o['id'] === 'string' &&
      typeof o['title'] === 'string' &&
      typeof o['body'] === 'string' &&
      typeof o['createdAt'] === 'number' &&
      typeof o['updatedAt'] === 'number'
    );
  });
}

/** Markdown export of a note. */
export function noteToMarkdown(note: Note): string {
  const created = new Date(note.createdAt).toLocaleString();
  return `# ${note.title.trim() || 'Untitled notes'}\n\n_Captured with SignFlow · ${created}_\n\n${note.body.trim()}\n`;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
