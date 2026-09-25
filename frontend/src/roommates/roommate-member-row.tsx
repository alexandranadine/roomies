import { MoreHorizontal } from 'lucide-react';
import { Badge, IconButton, Menu } from '../components/ui/index.js';
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
 * Active roommate row. Membership ids stay in React state — never rendered.
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

  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-base font-medium text-text-primary">{name}</p>
          {isCurrent ? <Badge variant="neutral">You</Badge> : null}
        </div>
        {isCurrent && currentUserRole !== undefined ? (
          <p className="mt-1 text-sm text-text-secondary">
            {homeRoleLabel(currentUserRole)}
          </p>
        ) : null}
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
    </li>
  );
}
