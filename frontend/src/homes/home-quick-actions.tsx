import {
  ClipboardDocumentCheckIcon,
  UserGroupIcon,
  UserPlusIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { Link } from 'react-router';
import { cn } from '../components/ui/cn.js';

export type HomeQuickActionsProps = {
  homeId: string;
  isAdmin: boolean;
  onOpenActions: () => void;
  onAddTask: () => void;
  onInviteRoommate: () => void;
};

const tileClassName = cn(
  'flex min-h-14 flex-col items-center justify-center gap-1 px-1.5 py-2 text-center',
  'text-xs font-semibold text-text-primary outline-none',
  'hover:bg-subtle',
  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
);

/**
 * Prompt + real Home actions on one surface.
 */
export function HomeQuickActions({
  homeId,
  isAdmin,
  onOpenActions,
  onAddTask,
  onInviteRoommate,
}: HomeQuickActionsProps) {
  const roommatesHref = `/homes/${encodeURIComponent(homeId)}/roommates`;
  const maintenanceHref = `/homes/${encodeURIComponent(homeId)}/maintenance`;

  return (
    <section aria-label="Quick actions">
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        <button
          type="button"
          onClick={onOpenActions}
          className={cn(
            'flex min-h-11 w-full items-center border-b border-border px-3.5 text-left text-sm text-text-muted',
            'outline-none hover:bg-subtle hover:text-text-secondary',
            'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
          )}
        >
          What needs doing?
        </button>
        <div className="grid grid-cols-3 divide-x divide-border">
          <button type="button" className={tileClassName} onClick={onAddTask}>
            <ClipboardDocumentCheckIcon
              className="size-5 text-brand"
              aria-hidden="true"
            />
            Add task
          </button>
          {isAdmin ? (
            <button
              type="button"
              className={tileClassName}
              onClick={onInviteRoommate}
            >
              <UserPlusIcon className="size-5 text-brand" aria-hidden="true" />
              Invite
            </button>
          ) : (
            <Link to={roommatesHref} className={tileClassName}>
              <UserGroupIcon className="size-5 text-brand" aria-hidden="true" />
              Roommates
            </Link>
          )}
          <Link to={maintenanceHref} className={tileClassName}>
            <WrenchScrewdriverIcon
              className="size-5 text-brand"
              aria-hidden="true"
            />
            Maintenance
          </Link>
        </div>
      </div>
    </section>
  );
}
