import { useId, type ReactNode } from 'react';
import { cn } from './cn.js';

export type FieldControlState = {
  controlId: string;
  helperId: string;
  errorId: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
};

type UseFieldIdsOptions = {
  id?: string;
  helperText?: ReactNode;
  errorText?: ReactNode;
  invalid?: boolean;
  required?: boolean;
};

export function useFieldIds({
  id,
  helperText,
  errorText,
  invalid = false,
  required = false,
}: UseFieldIdsOptions = {}): FieldControlState {
  const reactId = useId();
  const controlId = id ?? reactId;
  const helperId = `${controlId}-helper`;
  const errorId = `${controlId}-error`;

  const describedByParts: string[] = [];
  if (helperText) describedByParts.push(helperId);
  if (invalid && errorText) describedByParts.push(errorId);

  return {
    controlId,
    helperId,
    errorId,
    describedBy:
      describedByParts.length > 0 ? describedByParts.join(' ') : undefined,
    invalid,
    required,
  };
}

type FieldLabelProps = {
  htmlFor: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
};

export function FieldLabel({
  htmlFor,
  required,
  children,
  className,
}: FieldLabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('text-sm font-medium text-text-primary', className)}
    >
      {children}
      {required ? (
        <span className="text-danger" aria-hidden="true">
          {' '}
          *
        </span>
      ) : null}
    </label>
  );
}

type FieldHelperProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export function FieldHelper({ id, children, className }: FieldHelperProps) {
  return (
    <p id={id} className={cn('text-sm text-text-muted', className)}>
      {children}
    </p>
  );
}

type FieldErrorProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export function FieldError({ id, children, className }: FieldErrorProps) {
  return (
    <p
      id={id}
      role="alert"
      className={cn('text-sm font-medium text-danger', className)}
    >
      {children}
    </p>
  );
}

type FieldFrameProps = {
  children: ReactNode;
  className?: string;
};

export function FieldFrame({ children, className }: FieldFrameProps) {
  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      {children}
    </div>
  );
}
