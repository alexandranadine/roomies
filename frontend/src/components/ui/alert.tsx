import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';

const variantClasses = {
  info: 'border-info/25 bg-info-soft text-info',
  success: 'border-success/25 bg-success-soft text-success',
  warning: 'border-warning/25 bg-warning-soft text-warning',
  danger: 'border-danger/25 bg-danger-soft text-danger',
} as const;

export type AlertVariant = keyof typeof variantClasses;

export type AlertProps = Omit<ComponentProps<'div'>, 'title'> & {
  variant?: AlertVariant;
  title?: ReactNode;
  children: ReactNode;
};

/**
 * Inline feedback. Only `danger` uses role="alert" for assertive announcement.
 * Other variants use role="status".
 */
export function Alert({
  className,
  variant = 'info',
  title,
  children,
  ...props
}: AlertProps) {
  const assertive = variant === 'danger';

  return (
    <div
      role={assertive ? 'alert' : 'status'}
      className={cn(
        'rounded-xl border px-4 py-3 text-sm',
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {title ? <p className="font-semibold text-current">{title}</p> : null}
      <div className={cn(title && 'mt-1', 'text-current')}>{children}</div>
    </div>
  );
}
