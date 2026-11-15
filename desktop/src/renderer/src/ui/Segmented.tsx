import { useId, useRef, type KeyboardEvent } from 'react';

interface Option<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  hideLabel?: boolean;
}

/** A small set of mutually exclusive choices. ARIA radio group: arrows move the selection. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled, hideLabel }: SegmentedProps<T>) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta || disabled) return;
    e.preventDefault();
    const idx = options.findIndex((o) => o.value === value);
    const next = (idx + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };

  return (
    <div className={`ui-segmented-field ${disabled ? 'is-disabled' : ''}`}>
      <span id={`${id}-label`} className={hideLabel ? 'sr-only' : 'ui-field-label'}>
        {label}
      </span>
      <div className="ui-segmented" role="radiogroup" aria-labelledby={`${id}-label`} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}>
        {options.map((o, i) => (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            disabled={disabled}
            className="ui-segment"
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
