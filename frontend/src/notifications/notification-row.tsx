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
import { markNotificationReadInCache } from './notifications-list-cache.js';
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
 * - Unread: await mark-one (no optimistic read). On success, update the cached
 *   row, invalidate Notifications in the background, then navigate. On concealed
 *   404, invalidate and do not navigate. On other errors, still navigate so a
 *   transient mark failure does not trap the user.
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
      markNotificationReadInCache(queryClient, item.id);
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      void navigate(destinationPath);
    } catch (error) {
      if (isConcealedNotFound(error)) {
        void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
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
          'flex w-full min-h-control-lg gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 text-left shadow-card hover:bg-subtle/50 lg:gap-3 lg:px-4 lg:py-2.5',
          'outline-none transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          'disabled:cursor-wait',
        )}
      >
        <NotificationIcon name={presentation.icon} />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'min-w-0 break-words text-sm text-text-primary',
              unread ? 'font-semibold' : 'font-normal',
            )}
          >
            {unread ? <VisuallyHidden>Unread</VisuallyHidden> : null}
            {presentation.message}
          </p>
          {presentation.sourceTitle !== null ? (
            <p className="mt-0.5 min-w-0 break-words text-sm text-text-secondary">
              {presentation.sourceTitle}
            </p>
          ) : null}
          <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-text-muted">
            <span className="min-w-0 break-words">{item.home.name}</span>
            {timestamp.length > 0 ? (
              <time dateTime={item.occurredAt}>{timestamp}</time>
            ) : null}
          </p>
        </div>
        {unread ? (
          <span
            className="mt-1.5 size-2 shrink-0 rounded-full bg-brand"
            aria-hidden="true"
          />
        ) : null}
      </button>
    </li>
  );
}
