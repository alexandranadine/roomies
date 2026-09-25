import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../components/ui/cn.js';
import {
  FieldError,
  FieldFrame,
  FieldHelper,
  FieldLabel,
  useFieldIds,
} from '../components/ui/field.js';

export type SelectFieldProps = Omit<ComponentProps<'select'>, 'id'> & {
  label: ReactNode;
  id?: string;
  helperText?: ReactNode;
  errorText?: ReactNode;
  invalid?: boolean;
};

/** Labeled native select matching Roomies field chrome. */
export function SelectField({
  label,
  id,
  helperText,
  errorText,
  invalid = false,
  required,
  disabled,
  className,
  children,
  ...props
}: SelectFieldProps) {
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
          'flex min-h-control-lg items-center rounded-lg border bg-surface px-3',
          'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
          invalid ? 'border-danger bg-danger-soft/40' : 'border-border-strong',
          disabled && 'border-border bg-subtle text-text-disabled',
        )}
      >
        <select
          id={field.controlId}
          className={cn(
            'min-w-0 flex-1 bg-transparent py-2 text-base text-text-primary outline-none',
            'disabled:cursor-not-allowed disabled:text-text-disabled',
            className,
          )}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          aria-describedby={field.describedBy}
          disabled={disabled}
          required={required}
          {...props}
        >
          {children}
        </select>
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
