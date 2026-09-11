import type { ReactNode } from 'react';
import { cn } from './cn.js';

export type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

/**
 * Simple empty-collection layout. No illustrations or mascots.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-xl border border-dashed border-border-strong bg-subtle/60 px-5 py-8',
        className,
      )}
    >
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      {description ? (
        <p className="max-w-prose text-sm text-text-secondary">{description}</p>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
