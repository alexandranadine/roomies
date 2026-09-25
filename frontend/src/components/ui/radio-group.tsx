import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from './cn.js';

export type RadioGroupLayout = 'stack' | 'tiles';

export type RadioGroupProps = Omit<
  ComponentProps<typeof BaseRadioGroup>,
  'className'
> & {
  label: ReactNode;
  className?: string;
  layout?: RadioGroupLayout;
};

/**
 * Mutually exclusive choice group for form selections.
 */
export function RadioGroup({
  label,
  className,
  layout = 'stack',
  children,
  ...props
}: RadioGroupProps) {
  const labelId = useId();

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div id={labelId} className="text-sm font-medium text-text-primary">
        {label}
      </div>
      <BaseRadioGroup
        aria-labelledby={labelId}
        className={
          layout === 'tiles'
            ? 'grid grid-cols-2 gap-1.5'
            : 'flex flex-col gap-1'
        }
        {...props}
      >
        {children}
      </BaseRadioGroup>
    </div>
  );
}

export type RadioVariant = 'default' | 'tile';

export type RadioProps = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  variant?: RadioVariant;
};

export function Radio({
  value,
  label,
  disabled,
  className,
  id,
  variant = 'default',
}: RadioProps) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center text-sm text-text-primary',
        variant === 'default' && 'min-h-control-lg gap-3',
        variant === 'tile' &&
          cn(
            'min-h-control-lg justify-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-center font-medium',
            'has-[[data-checked]]:border-brand has-[[data-checked]]:bg-brand-soft has-[[data-checked]]:text-brand',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
          ),
        disabled && 'cursor-not-allowed text-text-disabled',
        className,
      )}
    >
      <BaseRadio.Root
        id={id}
        value={value}
        disabled={disabled}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border bg-surface',
          'border-border-strong',
          'data-checked:border-brand',
          'data-disabled:border-border data-disabled:bg-subtle',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          variant === 'tile' && 'focus-visible:outline-none',
        )}
      >
        <BaseRadio.Indicator className="flex size-2.5 rounded-full bg-brand data-unchecked:hidden data-disabled:bg-text-disabled" />
      </BaseRadio.Root>
      <span>{label}</span>
    </label>
  );
}
