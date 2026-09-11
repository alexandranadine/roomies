import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';
import { IconButton } from './icon-button.js';

export const DialogRoot = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogPortal = BaseDialog.Portal;
export const DialogClose = BaseDialog.Close;

export type DialogBackdropProps = ComponentProps<typeof BaseDialog.Backdrop>;

export function DialogBackdrop({ className, ...props }: DialogBackdropProps) {
  return (
    <BaseDialog.Backdrop
      className={cn(
        'fixed inset-0 z-40 min-h-dvh bg-text-primary/40 transition-opacity',
        'data-ending-style:opacity-0 data-starting-style:opacity-0',
        'supports-[-webkit-touch-callout:none]:absolute',
        className,
      )}
      {...props}
    />
  );
}

export type DialogPopupProps = ComponentProps<typeof BaseDialog.Popup> & {
  /** Accessible title — required for unlabeled dialog prevention. */
  title: ReactNode;
  description?: ReactNode;
  /** Accessible name for the close control. */
  closeLabel?: string;
  showCloseButton?: boolean;
};

/**
 * Centered modal surface with focus trap, Escape dismissal, and focus restore
 * via Base UI Dialog.
 */
export function DialogPopup({
  className,
  title,
  description,
  children,
  closeLabel = 'Close dialog',
  showCloseButton = true,
  ...props
}: DialogPopupProps) {
  return (
    <BaseDialog.Portal>
      <DialogBackdrop />
      <BaseDialog.Viewport
        className={cn(
          'fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center',
        )}
      >
        <BaseDialog.Popup
          className={cn(
            'flex max-h-[min(100dvh-2rem,40rem)] w-full max-w-lg flex-col gap-3',
            'rounded-2xl border border-border bg-surface p-5 text-text-primary shadow-none',
            'outline-none transition-[transform,opacity]',
            'data-ending-style:scale-[0.98] data-ending-style:opacity-0',
            'data-starting-style:scale-[0.98] data-starting-style:opacity-0',
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
          <div className="min-h-0 overflow-y-auto">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export const Dialog = {
  Root: DialogRoot,
  Trigger: DialogTrigger,
  Portal: DialogPortal,
  Backdrop: DialogBackdrop,
  Popup: DialogPopup,
  Close: DialogClose,
  Title: BaseDialog.Title,
  Description: BaseDialog.Description,
};
