import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';
import {
  FieldError,
  FieldFrame,
  FieldHelper,
  FieldLabel,
  useFieldIds,
} from './field.js';

export type TextFieldProps = Omit<ComponentProps<'input'>, 'id'> & {
  label: ReactNode;
  id?: string;
  helperText?: ReactNode;
  errorText?: ReactNode;
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
};

/**
 * Labeled text input with helper/error associations.
 * Prefer native input under a styled wrapper.
 */
export function TextField({
  label,
  id,
  helperText,
  errorText,
  invalid = false,
  required,
  disabled,
  leading,
  trailing,
  className,
  ...props
}: TextFieldProps) {
  const field = useFieldIds({
    id,
    helperText,
    errorText,
    invalid,
    required,
  });

  return (
    <FieldFrame>
      <FieldLabel htmlFor={field.controlId} required={required}>
        {label}
      </FieldLabel>
      <div
        className={cn(
          'flex min-h-control-lg items-center gap-2 rounded-lg border bg-surface px-3',
          'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
          invalid ? 'border-danger bg-danger-soft/40' : 'border-border-strong',
          disabled && 'border-border bg-subtle text-text-disabled',
        )}
      >
        {leading ? (
          <span className="shrink-0 text-text-muted" aria-hidden="true">
            {leading}
          </span>
        ) : null}
        <input
          id={field.controlId}
          className={cn(
            'min-w-0 flex-1 bg-transparent py-2 text-base text-text-primary outline-none',
            'placeholder:text-text-muted disabled:cursor-not-allowed disabled:text-text-disabled',
            className,
          )}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          aria-describedby={field.describedBy}
          disabled={disabled}
          required={required}
          {...props}
        />
        {trailing ? (
          <span className="shrink-0 text-text-muted" aria-hidden="true">
            {trailing}
          </span>
        ) : null}
      </div>
      {helperText ? (
        <FieldHelper id={field.helperId}>{helperText}</FieldHelper>
      ) : null}
      {invalid && errorText ? (
        <FieldError id={field.errorId}>{errorText}</FieldError>
      ) : null}
    </FieldFrame>
  );
}
