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
 * Low-ceremony surface. Restrained border, ~16px radius, no shadow by default.
 */
export function Card({ className, padding = 'md', ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface',
        paddingClasses[padding],
        className,
      )}
      {...props}
    />
  );
}
