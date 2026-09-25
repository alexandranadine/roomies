import { Camera, CheckSquare, UserPlus, Users } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '../components/ui/cn.js';

export type HomeQuickActionsProps = {
  homeId: string;
  isAdmin: boolean;
  onOpenActions: () => void;
  onAddTask: () => void;
  onInviteRoommate: () => void;
  onHomePhoto: () => void;
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
  onHomePhoto,
}: HomeQuickActionsProps) {
  const roommatesHref = `/homes/${encodeURIComponent(homeId)}/roommates`;

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
          What’s on your mind, Roomies?
        </button>
        <div className="grid grid-cols-3 divide-x divide-border">
          <button type="button" className={tileClassName} onClick={onAddTask}>
            <CheckSquare className="size-5 text-brand" aria-hidden="true" />
            Add task
          </button>
          {isAdmin ? (
            <button
              type="button"
              className={tileClassName}
              onClick={onInviteRoommate}
            >
              <UserPlus className="size-5 text-brand" aria-hidden="true" />
              Invite
            </button>
          ) : (
            <Link to={roommatesHref} className={tileClassName}>
              <Users className="size-5 text-brand" aria-hidden="true" />
              Roommates
            </Link>
          )}
          <button type="button" className={tileClassName} onClick={onHomePhoto}>
            <Camera className="size-5 text-brand" aria-hidden="true" />
            Home photo
          </button>
        </div>
      </div>
    </section>
  );
}
