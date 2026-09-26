import {
  CameraIcon,
  ClipboardDocumentCheckIcon,
  UserPlusIcon,
} from '@heroicons/react/20/solid';
import { Sheet } from '../components/ui/index.js';
import type { HeroIcon } from './home-nav.js';

export type HomeActionSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  hasPhoto: boolean;
  onAddTask: () => void;
  onInviteRoommate: () => void;
  onHomePhoto: () => void;
};

/**
 * Lightweight action sheet of currently allowed Home actions.
 */
export function HomeActionSheet({
  open,
  onOpenChange,
  isAdmin,
  hasPhoto,
  onAddTask,
  onInviteRoommate,
  onHomePhoto,
}: HomeActionSheetProps) {
  return (
    <Sheet.Root open={open} onOpenChange={onOpenChange}>
      <Sheet.Popup
        side="bottom"
        title="Add to this Home"
        description="Choose something you can do right now."
        closeLabel="Close add actions"
      >
        <ul className="flex flex-col gap-1 p-0">
          <li>
            <ActionRow
              icon={ClipboardDocumentCheckIcon}
              label="Add task"
              onClick={() => {
                onOpenChange(false);
                onAddTask();
              }}
            />
          </li>
          {isAdmin ? (
            <li>
              <ActionRow
                icon={UserPlusIcon}
                label="Invite roommate"
                onClick={() => {
                  onOpenChange(false);
                  onInviteRoommate();
                }}
              />
            </li>
          ) : null}
          <li>
            <ActionRow
              icon={CameraIcon}
              label={hasPhoto ? 'Change Home photo' : 'Add Home photo'}
              onClick={() => {
                onOpenChange(false);
                onHomePhoto();
              }}
            />
          </li>
        </ul>
      </Sheet.Popup>
    </Sheet.Root>
  );
}

function ActionRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: HeroIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-control-lg w-full items-center gap-3 rounded-lg px-2 text-left text-sm font-medium text-text-primary outline-none hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <Icon className="size-5 text-brand" aria-hidden="true" />
      {label}
    </button>
  );
}
