import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Dialog } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { changeMembershipRole } from './change-membership-role-api.js';
import { demoteAdminDialogCopy } from './role-change-copy.js';
import {
  isStaleMembershipError,
  changeRoleErrorMessage,
} from './roommates-errors.js';

export type RemoveAdminAccessDialogProps = {
  homeId: string;
  membershipId: string;
  roommateName: string;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDemoted: () => void;
  onStaleMembership: () => Promise<void>;
  onUnauthenticated: () => void;
};

export function RemoveAdminAccessDialog({
  homeId,
  membershipId,
  roommateName,
  isSelf,
  open,
  onOpenChange,
  onDemoted,
  onStaleMembership,
  onUnauthenticated,
}: RemoveAdminAccessDialogProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const copy = demoteAdminDialogCopy(isSelf, roommateName);
  const demoteMutation = useMutation({
    mutationFn: () =>
      changeMembershipRole({ homeId, membershipId, role: 'ROOMMATE' }),
    retry: false,
  });

  const isPending = demoteMutation.isPending;

  function handleOpenChange(next: boolean) {
    if (isPending && !next) {
      return;
    }
    if (!next) {
      setErrorMessage(null);
      demoteMutation.reset();
    }
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (isPending) {
      return;
    }
    setErrorMessage(null);
    demoteMutation.reset();
    try {
      await demoteMutation.mutateAsync();
      onDemoted();
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthenticated();
        return;
      }
      if (isStaleMembershipError(error)) {
        await onStaleMembership();
      }
      setErrorMessage(changeRoleErrorMessage(error));
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Popup
        title={copy.title}
        description={copy.description}
        closeLabel={copy.closeLabel}
        showCloseButton={!isPending}
      >
        <div className="flex flex-col gap-3">
          {errorMessage ? <Alert variant="danger">{errorMessage}</Alert> : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              loading={isPending}
              disabled={isPending}
              onClick={() => {
                void handleConfirm();
              }}
            >
              {copy.confirmLabel}
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
