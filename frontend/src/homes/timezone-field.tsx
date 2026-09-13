import type { ComponentProps } from 'react';
import { useId } from 'react';
import { cn } from '../components/ui/cn.js';
import {
  FieldError,
  FieldFrame,
  FieldHelper,
  FieldLabel,
  useFieldIds,
} from '../components/ui/field.js';
import { listSupportedTimeZones } from './create-home-form-schema.js';

export type TimezoneFieldProps = Omit<
  ComponentProps<'input'>,
  'id' | 'list' | 'value' | 'onChange'
> & {
  label: string;
  id?: string;
  value: string;
  onChange: (value: string) => void;
  helperText?: string;
  errorText?: string;
  invalid?: boolean;
};

/**
 * Searchable IANA timezone input backed by a native datalist.
 */
export function TimezoneField({
  label,
  id,
  value,
  onChange,
  helperText,
  errorText,
  invalid = false,
  required,
  disabled,
  onBlur,
  name,
}: TimezoneFieldProps) {
  const listId = useId();
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
        <input
          id={field.controlId}
          name={name}
          list={listId}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onBlur={onBlur}
          disabled={disabled}
          required={required}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          aria-describedby={field.describedBy}
          className={cn(
            'min-w-0 flex-1 bg-transparent py-2 text-base text-text-primary outline-none',
            'placeholder:text-text-muted disabled:cursor-not-allowed disabled:text-text-disabled',
          )}
        />
      </div>
      <datalist id={listId}>
        {listSupportedTimeZones().map((timeZone) => (
          <option key={timeZone} value={timeZone} />
        ))}
      </datalist>
      {helperText ? (
        <FieldHelper id={field.helperId}>{helperText}</FieldHelper>
      ) : null}
      {invalid && errorText ? (
        <FieldError id={field.errorId}>{errorText}</FieldError>
      ) : null}
    </FieldFrame>
  );
}
