import { Bell } from 'lucide-react';
import { NavLink } from 'react-router';
import { cn } from '../components/ui/cn.js';
import { useNotificationsList } from './use-notifications-list.js';

function unreadCountFromPages(
  pages:
    | readonly { items: readonly { readAt: string | null }[] }[]
    | undefined,
): number {
  if (pages === undefined) {
    return 0;
  }
  return pages.reduce((sum, page) => {
    return (
      sum + page.items.filter((item) => item.readAt === null).length
    );
  }, 0);
}

const bellClassName = ({ isActive }: { isActive: boolean }) =>
  cn(
    'relative inline-flex size-control-lg items-center justify-center rounded-lg',
    'text-text-muted outline-none transition-colors',
    'hover:bg-subtle hover:text-text-primary',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    isActive && 'bg-subtle text-text-primary',
  );

/**
 * Global Notifications entry. Unread count uses the existing inbox query.
 */
export function NotificationBellLink() {
  const listQuery = useNotificationsList();
  const unread = unreadCountFromPages(listQuery.data?.pages);
  const accessibleName =
    unread > 0
      ? `Notifications, ${unread} unread`
      : 'Notifications';

  return (
    <NavLink
      to="/notifications"
      aria-label={accessibleName}
      className={bellClassName}
    >
      <Bell className="size-5" aria-hidden="true" />
      {unread > 0 ? (
        <span
          className="absolute top-1.5 right-1.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white"
          aria-hidden="true"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </NavLink>
  );
}
