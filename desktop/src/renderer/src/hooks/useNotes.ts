import { useCallback, useMemo } from 'react';
import { newId } from '../adapters/emitter';
import { activeNote, initialNotesState, isNotesState, notesReducer, type NotesAction } from '../state/notes';
import { usePersistentState } from './usePersistentState';

export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Notes documents, persisted to localStorage. */
export function useNotes(storageKey = 'signflow.notes') {
  const [state, setState] = usePersistentState(storageKey, () => initialNotesState(newId(), Date.now()), isNotesState);
  const dispatch = useCallback((action: NotesAction) => setState((s) => notesReducer(s, action)), [setState]);
  const current = useMemo(() => activeNote(state), [state]);

  return {
    state,
    current,
    create: useCallback(() => dispatch({ type: 'note/created', id: newId(), at: Date.now() }), [dispatch]),
    select: useCallback((id: string) => dispatch({ type: 'note/selected', id }), [dispatch]),
    rename: useCallback(
      (id: string, title: string) => dispatch({ type: 'note/renamed', id, title, at: Date.now() }),
      [dispatch],
    ),
    edit: useCallback((id: string, body: string) => dispatch({ type: 'note/edited', id, body, at: Date.now() }), [dispatch]),
    append: useCallback((text: string, at = Date.now()) => dispatch({ type: 'note/appended', text, at, timeLabel: timeLabel(at) }), [dispatch]),
    remove: useCallback((id: string) => dispatch({ type: 'note/deleted', id, at: Date.now(), newId: newId() }), [dispatch]),
    setTimestamps: useCallback((value: boolean) => dispatch({ type: 'timestamps/toggled', value }), [dispatch]),
  };
}

export type NotesController = ReturnType<typeof useNotes>;
