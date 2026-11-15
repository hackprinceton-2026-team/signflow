import { describe, expect, it } from 'vitest';
import { isEditableTarget, matchesCombo, SHORTCUTS, shortcutFor } from './shortcuts';

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

function keydown(k: string, mods: KeyboardEventInit = {}, target: HTMLElement = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('matchesCombo', () => {
  it('maps Mod to ⌘ on macOS and Ctrl elsewhere', () => {
    expect(matchesCombo(key('Enter', { metaKey: true }), 'Mod+Enter', true)).toBe(true);
    expect(matchesCombo(key('Enter', { ctrlKey: true }), 'Mod+Enter', true)).toBe(false);
    expect(matchesCombo(key('Enter', { ctrlKey: true }), 'Mod+Enter', false)).toBe(true);
    expect(matchesCombo(key('Enter', { metaKey: true }), 'Mod+Enter', false)).toBe(false);
  });

  it('requires exact modifiers and ignores letter case', () => {
    expect(matchesCombo(key('Enter', { metaKey: true, shiftKey: true }), 'Mod+Enter', true)).toBe(false);
    expect(matchesCombo(key('F', { metaKey: true, shiftKey: true }), 'Mod+Shift+F', true)).toBe(true);
    expect(matchesCombo(key('f', { metaKey: true }), 'Mod+Shift+F', true)).toBe(false);
    expect(matchesCombo(key('Escape'), 'Escape', true)).toBe(true);
    expect(matchesCombo(key('Escape', { altKey: true }), 'Escape', true)).toBe(false);
  });

  it('has no duplicate combos', () => {
    const combos = SHORTCUTS.map((s) => s.combo);
    expect(new Set(combos).size).toBe(combos.length);
  });
});

describe('isEditableTarget', () => {
  it('recognizes text fields but not toggles or buttons', () => {
    const make = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.firstElementChild as HTMLElement;
    };
    expect(isEditableTarget(make('<textarea></textarea>'))).toBe(true);
    expect(isEditableTarget(make('<input type="text" />'))).toBe(true);
    expect(isEditableTarget(make('<select></select>'))).toBe(true);
    expect(isEditableTarget(make('<input type="range" />'))).toBe(false);
    expect(isEditableTarget(make('<button></button>'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('shortcutFor', () => {
  const textarea = document.createElement('textarea');

  it('resolves global shortcuts', () => {
    expect(shortcutFor(keydown('2', { ctrlKey: true }), false)).toBe('workspace');
    expect(shortcutFor(keydown(',', { metaKey: true }), true)).toBe('settings');
    expect(shortcutFor(keydown('Enter', { ctrlKey: true, shiftKey: true }), false)).toBe('speak');
    expect(shortcutFor(keydown('x'), false)).toBeNull();
  });

  it('skips events already handled by a control, and key repeats', () => {
    const handled = keydown('Enter', { ctrlKey: true });
    handled.preventDefault();
    expect(shortcutFor(handled, false)).toBeNull();
    expect(shortcutFor(keydown('Enter', { ctrlKey: true, repeat: true }), false)).toBeNull();
  });

  it('while typing: plain keys and ⌘⌫ belong to the field; other Mod shortcuts still work', () => {
    expect(shortcutFor(keydown('Escape', {}, textarea), false)).toBeNull();
    expect(shortcutFor(keydown('Backspace', { ctrlKey: true }, textarea), false)).toBeNull();
    expect(shortcutFor(keydown('Enter', { ctrlKey: true }, textarea), false)).toBe('confirm');
    expect(shortcutFor(keydown('Backspace', { ctrlKey: true }), false)).toBe('discard');
  });
});
