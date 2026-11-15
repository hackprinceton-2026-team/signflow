import type { HTMLAttributes, ReactNode } from 'react';

export type StatusTone = 'neutral' | 'live' | 'success' | 'warning' | 'danger' | 'accent';

interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  /** Animate the dot (e.g. while recognizing). */
  pulse?: boolean;
  /** Glass styling for use over the camera. */
  glass?: boolean;
  children: ReactNode;
}

/** Status is always text + dot, never color alone. */
export function StatusPill({ tone = 'neutral', pulse, glass, children, className = '', ...rest }: StatusPillProps) {
  return (
    <span className={`ui-pill ui-pill-${tone} ${glass ? 'ui-pill-glass' : ''} ${className}`} {...rest}>
      <span className={`ui-pill-dot ${pulse ? 'is-pulsing' : ''}`} aria-hidden="true" />
      {children}
    </span>
  );
}
