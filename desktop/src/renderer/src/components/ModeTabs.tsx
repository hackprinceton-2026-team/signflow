import type { KeyboardEvent } from 'react';

export type AppMode = 'conversation' | 'notes';

const MODES: { id: AppMode; label: string; hint: string }[] = [
  { id: 'conversation', label: 'Conversation', hint: 'Confirmed sentences are spoken aloud' },
  { id: 'notes', label: 'Notes', hint: 'Confirmed sentences go into your notes, silently' },
];

export function isAppMode(v: unknown): v is AppMode {
  return v === 'conversation' || v === 'notes';
}

export function ModeTabs({ mode, onChange }: { mode: AppMode; onChange: (m: AppMode) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const idx = MODES.findIndex((m) => m.id === mode);
    const next = MODES[(idx + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length];
    if (next) onChange(next.id);
  };
  return (
    <div className="mode-tabs" role="tablist" aria-label="Mode" onKeyDown={onKeyDown}>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="tab"
          aria-selected={mode === m.id}
          tabIndex={mode === m.id ? 0 : -1}
          title={m.hint}
          className={`mode-tab ${mode === m.id ? 'active' : ''}`}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
