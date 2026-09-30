import { EllipsisHorizontalIcon } from '@heroicons/react/20/solid';
import { IconButton, InitialsAvatar, Menu } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import { roommateRosterRoleLabel } from '../homes/home-role-label.js';
import type { ActiveHome } from '../homes/homes-api.js';
import {
  demoteAdminMenuLabel,
  MAKE_ADMIN_MENU_LABEL,
} from './role-change-copy.js';

export type RoommateMemberRowProps = {
  name: string;
  isCurrent: boolean;
  role: ActiveHome['role'];
  showAdminActions: boolean;
  actionsDisabled: boolean;
  onMakeAdmin: () => void;
  onMakeRoommate: () => void;
  onRemove: () => void;
};

/**
 * Active roommate card. Membership ids stay in React state — never rendered.
 * Role labels come from the roster DTO, not a client-side default.
 */
export function RoommateMemberRow({
  name,
  isCurrent,
  role,
  showAdminActions,
  actionsDisabled,
  onMakeAdmin,
  onMakeRoommate,
  onRemove,
}: RoommateMemberRowProps) {
  const showSelfDemote = showAdminActions && isCurrent;
  const showOtherAdminActions = showAdminActions && !isCurrent;
  const showMakeAdmin = showOtherAdminActions && role === 'ROOMMATE';
  const showMakeRoommate = showOtherAdminActions && role === 'ADMIN';
  const hasMenu = showSelfDemote || showMakeAdmin || showMakeRoommate;
  const avatarLabel = isCurrent ? `${name} (you)` : name;
  const roleLabel = roommateRosterRoleLabel(role);

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
                <span aria-hidden="true"> · </span>
                {roleLabel}
              </>
            ) : (
              roleLabel
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
                  <EllipsisHorizontalIcon className="size-5" aria-hidden="true" />
                </IconButton>
              }
            />
            <Menu.Popup>
              {showMakeAdmin ? (
                <Menu.Item
                  disabled={actionsDisabled}
                  onClick={() => {
                    onMakeAdmin();
                  }}
                >
                  {MAKE_ADMIN_MENU_LABEL}
                </Menu.Item>
              ) : null}
              {showSelfDemote || showMakeRoommate ? (
                <Menu.Item
                  disabled={actionsDisabled}
                  onClick={() => {
                    onMakeRoommate();
                  }}
                >
                  {demoteAdminMenuLabel(showSelfDemote)}
                </Menu.Item>
              ) : null}
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
