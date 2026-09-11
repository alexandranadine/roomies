import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

export type TabsRootProps = ComponentProps<typeof BaseTabs.Root>;

export function TabsRoot({ className, ...props }: TabsRootProps) {
  return (
    <BaseTabs.Root
      className={cn('flex w-full flex-col gap-3', className)}
      {...props}
    />
  );
}

export type TabsListProps = ComponentProps<typeof BaseTabs.List>;

export function TabsList({ className, ...props }: TabsListProps) {
  return (
    <BaseTabs.List
      className={cn(
        'relative flex w-full gap-1 overflow-x-auto border-b border-border',
        className,
      )}
      {...props}
    />
  );
}

export type TabsTabProps = ComponentProps<typeof BaseTabs.Tab>;

export function TabsTab({ className, ...props }: TabsTabProps) {
  return (
    <BaseTabs.Tab
      className={cn(
        'relative inline-flex min-h-control-lg shrink-0 items-center justify-center px-3 text-sm font-medium',
        'text-text-muted outline-none select-none',
        'hover:text-text-primary',
        'data-selected:text-text-primary',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent',
        'data-selected:after:bg-brand',
        className,
      )}
      {...props}
    />
  );
}

export type TabsPanelProps = ComponentProps<typeof BaseTabs.Panel>;

export function TabsPanel({ className, ...props }: TabsPanelProps) {
  return (
    <BaseTabs.Panel
      className={cn('text-sm text-text-secondary outline-none', className)}
      {...props}
    />
  );
}

/**
 * Accessible tablist / tab / tabpanel. Labels belong to feature code.
 */
export const Tabs = {
  Root: TabsRoot,
  List: TabsList,
  Tab: TabsTab,
  Panel: TabsPanel,
};
