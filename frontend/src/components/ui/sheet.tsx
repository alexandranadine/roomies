import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';
import { IconButton } from './icon-button.js';

export const SheetRoot = BaseDialog.Root;
export const SheetTrigger = BaseDialog.Trigger;
export const SheetClose = BaseDialog.Close;

const sideClasses = {
  right:
    'inset-y-0 right-0 h-full w-full max-w-md rounded-none border-l sm:rounded-l-2xl data-ending-style:translate-x-4 data-starting-style:translate-x-4',
  bottom:
    'inset-x-0 bottom-0 max-h-[min(92dvh,40rem)] w-full rounded-t-2xl border-t data-ending-style:translate-y-4 data-starting-style:translate-y-4',
} as const;

export type SheetSide = keyof typeof sideClasses;

export type SheetPopupProps = ComponentProps<typeof BaseDialog.Popup> & {
  title: ReactNode;
  description?: ReactNode;
  side?: SheetSide;
  closeLabel?: string;
  showCloseButton?: boolean;
};

/**
 * Edge-anchored overlay panel composed on Base UI Dialog (shared focus management).
 * `right` suits detail/action panels; `bottom` suits compact mobile sheets.
 */
export function SheetPopup({
  className,
  title,
  description,
  children,
  side = 'right',
  closeLabel = 'Close panel',
  showCloseButton = true,
  ...props
}: SheetPopupProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        className={cn(
          'fixed inset-0 z-40 min-h-dvh bg-text-primary/40 transition-opacity',
          'data-ending-style:opacity-0 data-starting-style:opacity-0',
          'supports-[-webkit-touch-callout:none]:absolute',
        )}
      />
      <BaseDialog.Viewport className="fixed inset-0 z-50">
        <BaseDialog.Popup
          className={cn(
            'fixed z-50 flex flex-col gap-3 border-border bg-surface p-5 text-text-primary outline-none',
            'transition-[transform,opacity]',
            'data-ending-style:opacity-0 data-starting-style:opacity-0',
            sideClasses[side],
            className,
          )}
          {...props}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <BaseDialog.Title className="text-lg font-semibold tracking-tight">
                {title}
              </BaseDialog.Title>
              {description ? (
                <BaseDialog.Description className="text-sm text-text-secondary">
                  {description}
                </BaseDialog.Description>
              ) : null}
            </div>
            {showCloseButton ? (
              <BaseDialog.Close
                render={
                  <IconButton variant="subtle" aria-label={closeLabel}>
                    <X className="size-5" aria-hidden="true" />
                  </IconButton>
                }
              />
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export const Sheet = {
  Root: SheetRoot,
  Trigger: SheetTrigger,
  Popup: SheetPopup,
  Close: SheetClose,
  Title: BaseDialog.Title,
  Description: BaseDialog.Description,
};
