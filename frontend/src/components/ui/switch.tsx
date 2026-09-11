import { Switch as BaseSwitch } from '@base-ui/react/switch';
import type { ReactNode } from 'react';
import { cn } from './cn.js';

export type SwitchProps = {
  label: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
};

/**
 * Immediate binary setting control. Prefer Checkbox for deferred form booleans.
 */
export function Switch({
  label,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  name,
  id,
  className,
}: SwitchProps) {
  return (
    <label
      className={cn(
        'inline-flex min-h-control-lg cursor-pointer items-center gap-3 text-sm text-text-primary',
        disabled && 'cursor-not-allowed text-text-disabled',
        className,
      )}
    >
      <BaseSwitch.Root
        id={id}
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange?.(next)}
        className={cn(
          'relative flex h-6 w-11 shrink-0 rounded-full border border-border-strong bg-subtle p-0.5',
          'transition-colors data-checked:border-brand data-checked:bg-brand',
          'data-disabled:border-border data-disabled:bg-border',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        <BaseSwitch.Thumb
          className={cn(
            'block size-5 rounded-full bg-surface shadow-sm',
            'transition-transform data-checked:translate-x-5',
            'data-disabled:bg-subtle',
          )}
        />
      </BaseSwitch.Root>
      <span>{label}</span>
    </label>
  );
}
