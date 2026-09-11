import { Menu as BaseMenu } from '@base-ui/react/menu';
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

export const MenuRoot = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const MenuPortal = BaseMenu.Portal;
export const MenuPositioner = BaseMenu.Positioner;

export type MenuPopupProps = ComponentProps<typeof BaseMenu.Popup>;

export function MenuPopup({ className, ...props }: MenuPopupProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner className="z-50 outline-none" sideOffset={6}>
        <BaseMenu.Popup
          className={cn(
            'min-w-44 origin-[var(--transform-origin)] rounded-xl border border-border bg-surface py-1 text-text-primary shadow-none outline-none',
            'transition-[transform,opacity] data-ending-style:scale-[0.98] data-ending-style:opacity-0',
            'data-starting-style:scale-[0.98] data-starting-style:opacity-0',
            className,
          )}
          {...props}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export type MenuItemProps = ComponentProps<typeof BaseMenu.Item>;

export function MenuItem({ className, ...props }: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={cn(
        'flex min-h-10 cursor-default items-center px-3 text-sm outline-none select-none',
        'data-highlighted:bg-subtle data-highlighted:text-text-primary',
        'data-disabled:text-text-disabled',
        className,
      )}
      {...props}
    />
  );
}

export type MenuSeparatorProps = ComponentProps<typeof BaseMenu.Separator>;

export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return (
    <BaseMenu.Separator
      className={cn('my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

/**
 * Action menu / dropdown. Keyboard interaction via Base UI Menu.
 */
export const Menu = {
  Root: MenuRoot,
  Trigger: MenuTrigger,
  Portal: MenuPortal,
  Positioner: MenuPositioner,
  Popup: MenuPopup,
  Item: MenuItem,
  Separator: MenuSeparator,
};
