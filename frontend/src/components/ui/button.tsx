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

export type ButtonVariant = keyof typeof variantClasses;

export type ButtonProps = Omit<ComponentProps<'button'>, 'children'> & {
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
};

/**
 * Primary interaction control. Default size targets ~44px touch height.
 */
export function Button({
  className,
  variant = 'primary',
  loading = false,
  disabled,
  icon,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  const isDisabled = Boolean(disabled || loading);

  return (
    <button
      type={type}
      className={cn(
        'relative inline-flex min-h-control-lg items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold',
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
      <span
        className={cn('inline-flex items-center gap-2', loading && 'invisible')}
      >
        {icon}
        {children}
      </span>
    </button>
  );
}
