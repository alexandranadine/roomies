import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';

export type CheckboxProps = {
  label: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  id?: string;
  className?: string;
  rootProps?: Omit<
    ComponentProps<typeof BaseCheckbox.Root>,
    | 'checked'
    | 'defaultChecked'
    | 'onCheckedChange'
    | 'disabled'
    | 'required'
    | 'name'
    | 'value'
    | 'id'
    | 'className'
  >;
};

/**
 * Boolean form selection control. Not for task-completion affordances.
 */
export function Checkbox({
  label,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  required,
  name,
  value,
  id,
  className,
  rootProps,
}: CheckboxProps) {
  return (
    <label
      className={cn(
        'inline-flex min-h-control-lg cursor-pointer items-center gap-3 text-sm text-text-primary',
        disabled && 'cursor-not-allowed text-text-disabled',
        className,
      )}
    >
      <BaseCheckbox.Root
        id={id}
        name={name}
        value={value}
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        required={required}
        onCheckedChange={(next) => onCheckedChange?.(next)}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-md border bg-surface',
          'border-border-strong text-white',
          'data-checked:border-brand data-checked:bg-brand',
          'data-disabled:border-border data-disabled:bg-subtle data-disabled:text-text-disabled',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
        {...rootProps}
      >
        <BaseCheckbox.Indicator className="flex data-unchecked:hidden">
          <Check className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span>{label}</span>
    </label>
  );
}
