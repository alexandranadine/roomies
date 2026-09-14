import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '../components/ui/cn.js';
import { VisuallyHidden } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { presentNotification } from './notification-copy.js';
import { notificationDestinationPath } from './notification-destination.js';
import { formatNotificationTimestamp } from './notification-format.js';
import { NotificationIcon } from './notification-icon.js';
import {
  markNotificationRead,
  type NotificationListItem,
} from './notifications-api.js';
import { notificationKeys } from './notifications-query-keys.js';

export type NotificationRowProps = {
  item: NotificationListItem;
};

function isConcealedNotFound(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

/**
 * Activate behavior (deterministic):
 * - Already read: navigate using destination.homeId immediately (no mark-one).
 * - Unread: await mark-one (no optimistic read). On success, invalidate the
 *   global Notification cache, then navigate. On concealed 404, invalidate and
 *   do not navigate. On other errors, still navigate so a transient mark
 *   failure does not trap the user.
 */
export function NotificationRow({ item }: NotificationRowProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const presentation = presentNotification(item);
  const timestamp = formatNotificationTimestamp(item.occurredAt);
  const unread = item.readAt === null;
  const destinationPath = notificationDestinationPath(item.destination);

  async function handleActivate() {
    if (pending) {
      return;
    }

    if (!unread) {
      void navigate(destinationPath);
      return;
    }

    setPending(true);
    try {
      await markNotificationRead(item.id);
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      void navigate(destinationPath);
    } catch (error) {
      if (isConcealedNotFound(error)) {
        await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
        return;
      }
      void navigate(destinationPath);
    } finally {
      setPending(false);
    }
  }

  const accessibleName = unread
    ? `Unread. ${presentation.message}`
    : presentation.message;

  return (
    <li>
      <button
        type="button"
        disabled={pending}
        aria-busy={pending || undefined}
        aria-label={accessibleName}
        onClick={() => {
          void handleActivate();
        }}
        className={cn(
          'flex w-full min-h-control-lg gap-3 px-4 py-3 text-left',
          'outline-none transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
          'disabled:cursor-wait',
          unread ? 'bg-subtle' : 'bg-surface hover:bg-subtle/60',
        )}
      >
        <NotificationIcon name={presentation.icon} />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'break-words text-sm sm:text-base',
              unread
                ? 'font-medium text-text-primary'
                : 'font-normal text-text-primary',
            )}
          >
            {unread ? <VisuallyHidden>Unread</VisuallyHidden> : null}
            {presentation.message}
          </p>
          {presentation.sourceTitle !== null ? (
            <p className="mt-0.5 break-words text-sm text-text-secondary">
              {presentation.sourceTitle}
            </p>
          ) : null}
          <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-text-muted">
            <span className="min-w-0 break-words">{item.home.name}</span>
            {timestamp.length > 0 ? (
              <time dateTime={item.occurredAt}>{timestamp}</time>
            ) : null}
          </p>
        </div>
      </button>
    </li>
  );
}
