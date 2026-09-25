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
  'flex min-h-16 flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-2 py-2 text-center shadow-card',
  'text-xs font-semibold text-text-primary outline-none',
  'hover:bg-subtle',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
);

/**
 * Compact action panel using only currently valid Home actions.
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
    <section aria-label="Quick actions" className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onOpenActions}
        className={cn(
          'flex min-h-control-lg w-full items-center rounded-xl border border-border bg-surface px-4 text-left text-sm text-text-muted shadow-card',
          'outline-none hover:bg-subtle hover:text-text-secondary',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        What’s on your mind, Roomies?
      </button>
      <div className="flex gap-2">
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
    </section>
  );
}
