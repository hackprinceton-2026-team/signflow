import { describe, expect, it } from 'vitest';
import {
  activeNote,
  appendLine,
  initialNotesState,
  isNotesState,
  notesReducer,
  noteToMarkdown,
  wordCount,
  type NotesState,
} from './notes';

const base = (): NotesState => initialNotesState('n1', 1000);
const append = (s: NotesState, text: string) =>
  notesReducer(s, { type: 'note/appended', text, at: 2000, timeLabel: '03:28 PM' });

describe('notesReducer', () => {
  it('starts with one active empty note', () => {
    const s = base();
    expect(s.notes).toHaveLength(1);
    expect(activeNote(s)).toMatchObject({ id: 'n1', body: '' });
  });

  it('appends confirmed sentences as timestamped lines', () => {
    const s = append(append(base(), 'Hello.'), '  How are you?  ');
    expect(activeNote(s).body).toBe('[03:28 PM] Hello.\n[03:28 PM] How are you?');
    expect(activeNote(s).updatedAt).toBe(2000);
  });

  it('appends without timestamps when turned off, and ignores blanks', () => {
    let s = notesReducer(base(), { type: 'timestamps/toggled', value: false });
    s = append(append(s, 'Hello.'), '   ');
    expect(activeNote(s).body).toBe('Hello.');
  });

  it('appends to whichever note is active', () => {
    let s = notesReducer(base(), { type: 'note/created', id: 'n2', at: 1500, title: 'Second' });
    expect(s.activeId).toBe('n2');
    s = append(s, 'Into n2');
    s = notesReducer(s, { type: 'note/selected', id: 'n1' });
    s = append(s, 'Into n1');
    expect(s.notes.find((n) => n.id === 'n2')?.body).toContain('Into n2');
    expect(s.notes.find((n) => n.id === 'n1')?.body).toContain('Into n1');
  });

  it('ignores selecting a missing note', () => {
    const s = base();
    expect(notesReducer(s, { type: 'note/selected', id: 'nope' })).toBe(s);
  });

  it('renames and edits', () => {
    let s = notesReducer(base(), { type: 'note/renamed', id: 'n1', title: 'CS 101', at: 5 });
    s = notesReducer(s, { type: 'note/edited', id: 'n1', body: 'typed', at: 6 });
    expect(activeNote(s)).toMatchObject({ title: 'CS 101', body: 'typed', updatedAt: 6 });
  });

  it('deleting the active note selects another; deleting the last creates a fresh one', () => {
    let s = notesReducer(base(), { type: 'note/created', id: 'n2', at: 2 });
    s = notesReducer(s, { type: 'note/deleted', id: 'n2', at: 3, newId: 'x' });
    expect(s.activeId).toBe('n1');
    s = notesReducer(s, { type: 'note/deleted', id: 'n1', at: 4, newId: 'fresh' });
    expect(s.notes.map((n) => n.id)).toEqual(['fresh']);
    expect(s.activeId).toBe('fresh');
  });
});

describe('notes helpers', () => {
  it('appendLine handles empty and newline-terminated bodies', () => {
    expect(appendLine('', 'a')).toBe('a');
    expect(appendLine('a\n', 'b')).toBe('a\nb');
    expect(appendLine('a', 'b')).toBe('a\nb');
  });

  it('exports Markdown with a title heading', () => {
    const note = { ...activeNote(base()), title: 'Lecture', body: 'Line one\n' };
    const md = noteToMarkdown(note);
    expect(md.startsWith('# Lecture\n')).toBe(true);
    expect(md).toContain('Captured with SignFlow');
    expect(md.trimEnd().endsWith('Line one')).toBe(true);
    expect(noteToMarkdown({ ...note, title: '  ' })).toMatch(/^# Untitled notes/);
  });

  it('counts words', () => {
    expect(wordCount('  hello   there\nfriend ')).toBe(3);
    expect(wordCount('   ')).toBe(0);
  });

  it('validates persisted state', () => {
    expect(isNotesState(base())).toBe(true);
    expect(isNotesState(null)).toBe(false);
    expect(isNotesState({ notes: [], activeId: 'a', timestamps: true })).toBe(false);
    expect(isNotesState({ notes: [{ id: 1 }], activeId: 'a', timestamps: true })).toBe(false);
  });
});
