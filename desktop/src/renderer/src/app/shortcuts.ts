/**
 * Keyboard shortcuts: one table drives both the global handler and the list
 * shown in Settings. "Mod" is ⌘ on macOS and Ctrl elsewhere.
 */
export type ShortcutId =
  | 'live'
  | 'workspace'
  | 'notes'
  | 'settings'
  | 'focus'
  | 'exitFocus'
  | 'confirm'
  | 'speak'
  | 'edit'
  | 'discard'
  | 'captions';

export interface Shortcut {
  id: ShortcutId;
  combo: string;
  label: string;
  group: 'Navigate' | 'Draft' | 'View';
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'live', combo: 'Mod+1', label: 'Go to Live', group: 'Navigate' },
  { id: 'workspace', combo: 'Mod+2', label: 'Go to Workspace', group: 'Navigate' },
  { id: 'notes', combo: 'Mod+3', label: 'Go to Notes', group: 'Navigate' },
  { id: 'settings', combo: 'Mod+,', label: 'Open Settings', group: 'Navigate' },
  { id: 'confirm', combo: 'Mod+Enter', label: 'Confirm draft', group: 'Draft' },
  { id: 'speak', combo: 'Mod+Shift+Enter', label: 'Confirm and speak draft', group: 'Draft' },
  { id: 'edit', combo: 'Mod+E', label: 'Edit draft', group: 'Draft' },
  { id: 'discard', combo: 'Mod+Backspace', label: 'Discard draft', group: 'Draft' },
  { id: 'focus', combo: 'Mod+Shift+F', label: 'Toggle Focus Mode', group: 'View' },
  { id: 'exitFocus', combo: 'Escape', label: 'Exit Focus Mode', group: 'View' },
  { id: 'captions', combo: 'Mod+Shift+C', label: 'Toggle floating captions', group: 'View' },
];

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** Does a keyboard event match a combo like "Mod+Shift+Enter" (exact modifiers)? */
export function matchesCombo(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, combo: string, mac = IS_MAC): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1]!;
  const wantMod = parts.includes('Mod');
  const wantShift = parts.includes('Shift');
  const wantAlt = parts.includes('Alt');
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (mod !== wantMod || e.shiftKey !== wantShift || e.altKey !== wantAlt || otherMod) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'submit'].includes(type);
  }
  return false;
}

/**
 * Which shortcut (if any) a keydown should trigger.
 * - Ignores events a focused control already handled (defaultPrevented),
 *   e.g. ⌘↵ inside the draft editor, so nothing fires twice.
 * - While typing, plain keys (Esc) belong to the field, and ⌘⌫ keeps its
 *   native "delete line" meaning.
 */
export function shortcutFor(e: KeyboardEvent, mac = IS_MAC): ShortcutId | null {
  if (e.defaultPrevented || e.repeat) return null;
  const editing = isEditableTarget(e.target);
  for (const s of SHORTCUTS) {
    if (!matchesCombo(e, s.combo, mac)) continue;
    if (editing && (!s.combo.includes('Mod') || s.id === 'discard')) return null;
    return s.id;
  }
  return null;
}
