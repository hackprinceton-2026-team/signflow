const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Enter: '↵', Backspace: '⌫', Escape: 'Esc' };
const PC_NAMES: Record<string, string> = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Enter: 'Enter', Backspace: 'Backspace', Escape: 'Esc' };

/** "Mod+Shift+Enter" → ["⌘","⇧","↵"] on macOS, ["Ctrl","Shift","Enter"] elsewhere. */
export function shortcutKeys(combo: string, mac = IS_MAC): string[] {
  return combo.split('+').map((k) => (mac ? MAC_SYMBOLS[k] : PC_NAMES[k]) ?? k.toUpperCase());
}

export function shortcutLabel(combo: string, mac = IS_MAC): string {
  return shortcutKeys(combo, mac).join(mac ? '' : '+');
}

/** Visual shortcut hint. Purely decorative; the action itself carries the name. */
export function Kbd({ combo, className = '' }: { combo: string; className?: string }) {
  return (
    <span className={`ui-kbd ${className}`} aria-hidden="true">
      {shortcutKeys(combo).map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}
