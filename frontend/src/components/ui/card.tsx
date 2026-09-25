import type { ComponentProps } from 'react';
import { cn } from './cn.js';

const paddingClasses = {
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
} as const;

export type CardProps = ComponentProps<'div'> & {
  padding?: keyof typeof paddingClasses;
};

/**
 * Low-ceremony surface. Warm border, ~16px radius, subtle household shadow.
 */
export function Card({ className, padding = 'md', ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface shadow-card',
        paddingClasses[padding],
        className,
      )}
      {...props}
    />
  );
}
