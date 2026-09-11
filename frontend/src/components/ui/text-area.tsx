import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';
import {
  FieldError,
  FieldFrame,
  FieldHelper,
  FieldLabel,
  useFieldIds,
} from './field.js';

export type TextAreaProps = Omit<ComponentProps<'textarea'>, 'id'> & {
  label: ReactNode;
  id?: string;
  helperText?: ReactNode;
  errorText?: ReactNode;
  invalid?: boolean;
};

/**
 * Labeled multiline text control with helper/error associations.
 */
export function TextArea({
  label,
  id,
  helperText,
  errorText,
  invalid = false,
  required,
  disabled,
  className,
  rows = 4,
  ...props
}: TextAreaProps) {
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
      <textarea
        id={field.controlId}
        rows={rows}
        className={cn(
          'min-h-24 w-full rounded-lg border bg-surface px-3 py-2 text-base text-text-primary',
          'placeholder:text-text-muted',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          'disabled:cursor-not-allowed disabled:border-border disabled:bg-subtle disabled:text-text-disabled',
          invalid ? 'border-danger bg-danger-soft/40' : 'border-border-strong',
          className,
        )}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        aria-describedby={field.describedBy}
        disabled={disabled}
        required={required}
        {...props}
      />
      {helperText ? (
        <FieldHelper id={field.helperId}>{helperText}</FieldHelper>
      ) : null}
      {invalid && errorText ? (
        <FieldError id={field.errorId}>{errorText}</FieldError>
      ) : null}
    </FieldFrame>
  );
}
