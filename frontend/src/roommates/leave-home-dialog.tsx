import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Dialog } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { archiveFinalMemberHome } from './archive-final-member-api.js';
import { leaveHome } from './leave-home-api.js';
import {
  isLeaveArchiveConflict,
  isStaleMembershipError,
  leaveHomeErrorMessage,
} from './roommates-errors.js';

export type LeaveHomeDialogProps = {
  homeId: string;
  homeName: string;
  membershipId: string;
  /** Advisory: active roster currently has one Admin member. Backend is final. */
  archivesHome: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLeft: () => void;
  onStaleMembership: () => Promise<void>;
  onUnauthenticated: () => void;
};

export function LeaveHomeDialog({
  homeId,
  homeName,
  membershipId,
  archivesHome,
  open,
  onOpenChange,
  onLeft,
  onStaleMembership,
  onUnauthenticated,
}: LeaveHomeDialogProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const leaveMutation = useMutation({
    mutationFn: () =>
      archivesHome
        ? archiveFinalMemberHome({ homeId })
        : leaveHome({ homeId, membershipId }),
    retry: false,
  });

  const isPending = leaveMutation.isPending;
  const title = archivesHome
    ? 'Leave and archive this Home?'
    : 'Leave this Home?';
  const description = archivesHome
    ? `You’re the last roommate. Leaving will archive ${homeName} and end your membership. Household history stays with the Home.`
    : `You’ll lose access to ${homeName} after you leave. Shared household history stays with the Home.`;
  const confirmLabel = archivesHome ? 'Leave and archive' : 'Leave Home';
  const closeLabel = archivesHome
    ? 'Close leave and archive'
    : 'Close leave Home';

  function handleOpenChange(next: boolean) {
    if (isPending && !next) {
      return;
    }
    if (!next) {
      setErrorMessage(null);
      leaveMutation.reset();
    }
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (isPending) {
      return;
    }
    setErrorMessage(null);
    leaveMutation.reset();
    try {
      await leaveMutation.mutateAsync();
      onLeft();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthenticated();
        return;
      }
      if (
        isStaleMembershipError(error) ||
        isLeaveArchiveConflict(error)
      ) {
        await onStaleMembership();
      }
      setErrorMessage(leaveHomeErrorMessage(error));
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Popup
        title={title}
        description={description}
        closeLabel={closeLabel}
        showCloseButton={!isPending}
      >
        <div className="flex flex-col gap-3">
          {errorMessage ? <Alert variant="danger">{errorMessage}</Alert> : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              variant="danger"
              loading={isPending}
              disabled={isPending}
              onClick={() => {
                void handleConfirm();
              }}
            >
              {confirmLabel}
            </Button>
            <Button
              type="button"
              variant="subtle"
              disabled={isPending}
              onClick={() => {
                handleOpenChange(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Dialog.Popup>
    </Dialog.Root>
  );
}
