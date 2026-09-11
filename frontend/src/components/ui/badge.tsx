import type { ComponentProps } from 'react';
import { cn } from './cn.js';

const variantClasses = {
  neutral: 'bg-subtle text-text-secondary border-border',
  brand: 'bg-brand-soft text-brand-soft-text border-brand/20',
  success: 'bg-success-soft text-success border-success/20',
  warning: 'bg-warning-soft text-warning border-warning/20',
  danger: 'bg-danger-soft text-danger border-danger/20',
  info: 'bg-info-soft text-info border-info/20',
  privacy: 'bg-privacy-soft text-privacy-text border-privacy-border',
} as const;

export type BadgeVariant = keyof typeof variantClasses;

export type BadgeProps = ComponentProps<'span'> & {
  variant?: BadgeVariant;
};

/**
 * Compact semantic status presentation. Domain states belong in feature code.
 */
export function Badge({
  className,
  variant = 'neutral',
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
