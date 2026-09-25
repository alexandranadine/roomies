import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Dialog } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { leaveHome } from './leave-home-api.js';
import {
  isStaleMembershipError,
  leaveHomeErrorMessage,
} from './roommates-errors.js';

export type LeaveHomeDialogProps = {
  homeId: string;
  homeName: string;
  membershipId: string;
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
  open,
  onOpenChange,
  onLeft,
  onStaleMembership,
  onUnauthenticated,
}: LeaveHomeDialogProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const leaveMutation = useMutation({
    mutationFn: () => leaveHome({ homeId, membershipId }),
    retry: false,
  });

  const isPending = leaveMutation.isPending;

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
      if (isStaleMembershipError(error)) {
        await onStaleMembership();
      }
      setErrorMessage(leaveHomeErrorMessage(error));
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Popup
        title="Leave Home"
        description={`Leave ${homeName}? You’ll lose access to this Home. Shared household history stays with the Home.`}
        closeLabel="Close leave Home"
        showCloseButton={!isPending}
      >
        <div className="flex flex-col gap-4">
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
              Leave Home
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
