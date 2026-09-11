import type { ComponentProps } from 'react';
import { cn } from './cn.js';
import { VisuallyHidden } from './visually-hidden.js';

type SpinnerProps = ComponentProps<'span'> & {
  /** Accessible label announced to assistive tech. Defaults to "Loading". */
  label?: string;
  size?: 'sm' | 'md';
  /**
   * When true, renders a purely visual spinner (for embedding inside a control
   * that already exposes busy/loading semantics).
   */
  decorative?: boolean;
};

/**
 * Small inline loading indicator. Decorative spin respects prefers-reduced-motion
 * via global base styles; the label remains available to AT unless decorative.
 */
export function Spinner({
  className,
  label = 'Loading',
  size = 'sm',
  decorative = false,
  ...props
}: SpinnerProps) {
  const glyph = (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block rounded-full border-2 border-current border-r-transparent',
        'motion-safe:animate-spin',
        size === 'sm' ? 'size-4' : 'size-5',
      )}
    />
  );

  if (decorative) {
    return (
      <span
        className={cn('inline-flex items-center justify-center', className)}
        {...props}
      >
        {glyph}
      </span>
    );
  }

  return (
    <span
      role="status"
      className={cn('inline-flex items-center justify-center', className)}
      {...props}
    >
      {glyph}
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}
