import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** Small text under the title. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Remove inner padding (for edge-to-edge content like lists or video). */
  flush?: boolean;
  headingLevel?: 2 | 3;
}

/** A titled surface. Uses <section> + heading so it shows up in the a11y tree. */
export function Card({ title, subtitle, actions, flush, headingLevel = 2, className = '', children, ...rest }: CardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={`ui-card ${flush ? 'is-flush' : ''} ${className}`} {...rest}>
      {(title || actions) && (
        <header className="ui-card-head">
          <div className="ui-card-titles">
            {title && <Heading className="ui-card-title">{title}</Heading>}
            {subtitle && <p className="ui-card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="ui-card-actions">{actions}</div>}
        </header>
      )}
      <div className="ui-card-body">{children}</div>
    </section>
  );
}
