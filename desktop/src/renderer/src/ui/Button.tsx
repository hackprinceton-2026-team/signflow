import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Keyboard shortcut hint shown inside the button (visual only). */
  shortcut?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, shortcut, className = '', children, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={`ui-btn ui-btn-${variant} ui-btn-${size} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children !== undefined && <span className="ui-btn-label">{children}</span>}
      {shortcut && (
        <span className="ui-btn-shortcut" aria-hidden="true">
          {shortcut}
        </span>
      )}
    </button>
  );
});

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: IconName;
  /** Required: icon-only buttons need an accessible name. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show the label as a native tooltip too (default true). */
  tooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', tooltip = true, className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={tooltip ? label : undefined}
      className={`ui-icon-btn ui-btn-${variant} ui-icon-btn-${size} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 15 : size === 'lg' ? 20 : 17} />
    </button>
  );
});
