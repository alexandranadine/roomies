import type { ComponentProps } from 'react';
import { cn } from './cn.js';

type VisuallyHiddenProps = ComponentProps<'span'>;

/**
 * Hides content visually while keeping it available to assistive technology.
 */
export function VisuallyHidden({ className, ...props }: VisuallyHiddenProps) {
  return (
    <span
      className={cn(
        'absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0',
        '[clip-path:inset(50%)] [clip:rect(0,0,0,0)]',
        className,
      )}
      {...props}
    />
  );
}
