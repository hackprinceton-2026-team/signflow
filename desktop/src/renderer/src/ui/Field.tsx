import { useId, type CSSProperties, type ReactNode } from 'react';

interface RangeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  description?: ReactNode;
}

/** Labeled slider with a live value readout and a filled track. */
export function RangeField({ label, value, min, max, step, onChange, format, description }: RangeFieldProps) {
  const id = useId();
  const text = format ? format(value) : String(value);
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="ui-field">
      <div className="ui-field-head">
        <label htmlFor={id} className="ui-field-label">
          {label}
        </label>
        <output htmlFor={id} className="ui-field-value tabular">
          {text}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="ui-range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={text}
        style={{ '--ui-range-pct': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {description && <p className="ui-field-desc">{description}</p>}
    </div>
  );
}

interface SelectFieldProps<T extends string | number> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  hideLabel?: boolean;
  className?: string;
}

/** Native <select> (best keyboard + screen reader support), styled to match. */
export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hideLabel,
  className = '',
}: SelectFieldProps<T>) {
  const id = useId();
  return (
    <div className={`ui-select-field ${className}`}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'ui-field-label'}>
        {label}
      </label>
      <div className="ui-select-wrap">
        <select
          id={id}
          className="ui-select"
          value={value}
          onChange={(e) => {
            const raw = e.target.value;
            const match = options.find((o) => String(o.value) === raw);
            if (match) onChange(match.value);
          }}
        >
          {options.map((o) => (
            <option key={String(o.value)} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <svg className="ui-select-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
