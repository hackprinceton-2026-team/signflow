import { useId, type ReactNode } from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Hide the label visually (it stays available to screen readers). */
  hideLabel?: boolean;
}

/** An accessible on/off switch (role="switch", Space/Enter toggle via <button>). */
export function Switch({ checked, onChange, label, description, disabled, hideLabel }: SwitchProps) {
  const id = useId();
  return (
    <div className={`ui-switch-row ${disabled ? 'is-disabled' : ''}`}>
      <span className={hideLabel ? 'sr-only' : 'ui-switch-text'}>
        <span id={`${id}-label`} className="ui-switch-label">
          {label}
        </span>
        {description && (
          <span id={`${id}-desc`} className="ui-switch-desc">
            {description}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        className="ui-switch"
        onClick={() => onChange(!checked)}
      >
        <span className="ui-switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}
