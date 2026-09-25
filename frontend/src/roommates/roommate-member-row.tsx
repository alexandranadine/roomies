import { MoreHorizontal } from 'lucide-react';
import { IconButton, InitialsAvatar, Menu } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import { homeRoleLabel } from '../homes/home-role-label.js';
import type { ActiveHome } from '../homes/homes-api.js';

export type RoommateMemberRowProps = {
  name: string;
  isCurrent: boolean;
  currentUserRole: ActiveHome['role'] | undefined;
  showAdminActions: boolean;
  actionsDisabled: boolean;
  onMakeAdmin: () => void;
  onMakeRoommate: () => void;
  onRemove: () => void;
};

/**
 * Active roommate card. Membership ids stay in React state — never rendered.
 * Other roommates never receive a role label; the DTO does not expose it.
 */
export function RoommateMemberRow({
  name,
  isCurrent,
  currentUserRole,
  showAdminActions,
  actionsDisabled,
  onMakeAdmin,
  onMakeRoommate,
  onRemove,
}: RoommateMemberRowProps) {
  const showSelfDemote = showAdminActions && isCurrent;
  const showOtherAdminActions = showAdminActions && !isCurrent;
  const hasMenu = showSelfDemote || showOtherAdminActions;
  const avatarLabel = isCurrent ? `${name} (you)` : name;

  return (
    <li
      className={cn(
        'rounded-xl border border-border bg-surface px-3 py-3 shadow-card',
        'transition-colors hover:bg-subtle/40',
      )}
    >
      <div className="flex items-center gap-3">
        <InitialsAvatar
          name={name}
          label={avatarLabel}
          size="lg"
          className="size-14 text-base lg:size-16 lg:text-lg"
        />
        <div className="min-w-0 flex-1">
          <p className="min-w-0 break-words text-sm font-bold leading-snug text-text-primary">
            {name}
          </p>
          <p className="mt-0.5 text-xs font-medium text-text-secondary">
            {isCurrent ? (
              <>
                <span className="text-brand">You</span>
                {currentUserRole !== undefined ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    {homeRoleLabel(currentUserRole)}
                  </>
                ) : null}
              </>
            ) : (
              'Household member'
            )}
          </p>
        </div>
        {hasMenu ? (
          <Menu.Root>
            <Menu.Trigger
              disabled={actionsDisabled}
              render={
                <IconButton
                  variant="subtle"
                  aria-label={`Actions for ${name}`}
                  disabled={actionsDisabled}
                  className="shrink-0"
                >
                  <MoreHorizontal className="size-5" aria-hidden="true" />
                </IconButton>
              }
            />
            <Menu.Popup>
              {showOtherAdminActions ? (
                <Menu.Item
                  disabled={actionsDisabled}
                  onClick={() => {
                    onMakeAdmin();
                  }}
                >
                  Make admin
                </Menu.Item>
              ) : null}
              <Menu.Item
                disabled={actionsDisabled}
                onClick={() => {
                  onMakeRoommate();
                }}
              >
                Make roommate
              </Menu.Item>
              {showOtherAdminActions ? (
                <>
                  <Menu.Separator />
                  <Menu.Item
                    disabled={actionsDisabled}
                    className="text-accent-coral-text data-highlighted:bg-accent-coral-soft data-highlighted:text-accent-coral-text"
                    onClick={() => {
                      onRemove();
                    }}
                  >
                    Remove from Home
                  </Menu.Item>
                </>
              ) : null}
            </Menu.Popup>
          </Menu.Root>
        ) : null}
      </div>
    </li>
  );
}
