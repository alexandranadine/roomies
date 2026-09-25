import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Dialog } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { removeRoommate } from './remove-roommate-api.js';
import {
  isStaleMembershipError,
  removeRoommateErrorMessage,
} from './roommates-errors.js';

export type RemoveRoommateDialogProps = {
  homeId: string;
  membershipId: string;
  roommateName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => Promise<void>;
  onStaleMembership: () => Promise<void>;
  onUnauthenticated: () => void;
};

export function RemoveRoommateDialog({
  homeId,
  membershipId,
  roommateName,
  open,
  onOpenChange,
  onRemoved,
  onStaleMembership,
  onUnauthenticated,
}: RemoveRoommateDialogProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const removeMutation = useMutation({
    mutationFn: () => removeRoommate({ homeId, membershipId }),
    retry: false,
  });

  const isPending = removeMutation.isPending;

  function handleOpenChange(next: boolean) {
    if (isPending && !next) {
      return;
    }
    if (!next) {
      setErrorMessage(null);
      removeMutation.reset();
    }
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (isPending) {
      return;
    }
    setErrorMessage(null);
    removeMutation.reset();
    try {
      await removeMutation.mutateAsync();
      await onRemoved();
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthenticated();
        return;
      }
      if (isStaleMembershipError(error)) {
        await onStaleMembership();
      }
      setErrorMessage(removeRoommateErrorMessage(error));
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Popup
        title="Remove from Home"
        description={`Remove ${roommateName} from this Home? They will lose access to the Home. Shared household history stays with the Home.`}
        closeLabel="Close remove from Home"
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
              Remove from Home
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
