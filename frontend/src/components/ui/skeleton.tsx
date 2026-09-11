import type { ComponentProps } from 'react';
import { cn } from './cn.js';

export type SkeletonProps = ComponentProps<'div'> & {
  /** When true, announce as a status region. Decorative by default. */
  announced?: boolean;
};

/**
 * Content placeholder. Pulse animation respects prefers-reduced-motion.
 * Decorative (`aria-hidden`) by default.
 */
export function Skeleton({
  className,
  announced = false,
  ...props
}: SkeletonProps) {
  return (
    <div
      className={cn(
        'rounded-md bg-border/80 motion-safe:animate-pulse',
        className,
      )}
      aria-hidden={announced ? undefined : true}
      {...(announced ? { role: 'status', 'aria-label': 'Loading' } : {})}
      {...props}
    />
  );
}
