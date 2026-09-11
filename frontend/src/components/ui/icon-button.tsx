import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';
import { Spinner } from './spinner.js';

const variantClasses = {
  primary:
    'bg-brand text-white hover:bg-brand-hover active:bg-brand-active disabled:bg-subtle disabled:text-text-disabled disabled:border-border',
  secondary:
    'bg-surface text-text-primary border-border-strong hover:bg-subtle active:bg-border/60 disabled:bg-subtle disabled:text-text-disabled disabled:border-border',
  subtle:
    'bg-transparent text-text-secondary border-transparent hover:bg-subtle hover:text-text-primary active:bg-border/50 disabled:text-text-disabled disabled:bg-transparent',
  danger:
    'bg-danger text-white hover:bg-danger/90 active:bg-danger/80 disabled:bg-subtle disabled:text-text-disabled disabled:border-border',
} as const;

type IconButtonVariant = keyof typeof variantClasses;

type IconButtonBaseProps = Omit<
  ComponentProps<'button'>,
  'children' | 'aria-label' | 'aria-labelledby'
> & {
  variant?: IconButtonVariant;
  loading?: boolean;
  children: ReactNode;
};

export type IconButtonProps = IconButtonBaseProps &
  (
    | { 'aria-label': string; 'aria-labelledby'?: never }
    | { 'aria-labelledby': string; 'aria-label'?: never }
  );

/**
 * Icon-only control. An accessible name via `aria-label` or `aria-labelledby`
 * is required. Touch target defaults to ~44px.
 */
export function IconButton({
  className,
  variant = 'subtle',
  loading = false,
  disabled,
  children,
  type = 'button',
  ...props
}: IconButtonProps) {
  const isDisabled = Boolean(disabled || loading);

  return (
    <button
      type={type}
      className={cn(
        'relative inline-flex size-control-lg shrink-0 items-center justify-center rounded-lg border',
        'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'disabled:cursor-not-allowed',
        variantClasses[variant],
        className,
      )}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span
          className="absolute inset-0 flex items-center justify-center"
          aria-hidden="true"
        >
          <Spinner decorative className="text-current" />
        </span>
      ) : null}
      <span className={cn(loading && 'invisible')}>{children}</span>
    </button>
  );
}
