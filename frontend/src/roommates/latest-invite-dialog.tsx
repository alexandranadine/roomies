import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Dialog, TextField } from '../components/ui/index.js';
import type { CreatedInvitation } from '../invitations/create-invitation-api.js';
import { revokeHomeInvitation } from '../invitations/revoke-invitation-api.js';
import { ApiError } from '../platform/api/index.js';
import { formatInvitationExpiration } from './invite-format.js';
import {
  isStaleMembershipError,
  revokeInvitationErrorMessage,
} from './roommates-errors.js';

export type LatestInviteDialogProps = {
  homeId: string;
  created: CreatedInvitation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRevoked: () => void;
  onStaleMembership: () => Promise<void>;
  onUnauthenticated: () => void;
};

export function LatestInviteDialog({
  homeId,
  created,
  open,
  onOpenChange,
  onRevoked,
  onStaleMembership,
  onUnauthenticated,
}: LatestInviteDialogProps) {
  const [copied, setCopied] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const revokeMutation = useMutation({
    mutationFn: () =>
      revokeHomeInvitation({
        homeId,
        invitationId: created.invitation.id,
      }),
    retry: false,
  });

  const isRevokePending = revokeMutation.isPending;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (isRevokePending && !next) {
      return;
    }
    if (!next) {
      setCopied(false);
    }
    onOpenChange(next);
  }

  function handleRevokeOpenChange(next: boolean) {
    if (isRevokePending && !next) {
      return;
    }
    if (!next) {
      setErrorMessage(null);
      revokeMutation.reset();
    }
    setRevokeOpen(next);
  }

  async function handleConfirmRevoke() {
    if (isRevokePending) {
      return;
    }
    setErrorMessage(null);
    revokeMutation.reset();
    try {
      await revokeMutation.mutateAsync();
      setRevokeOpen(false);
      onOpenChange(false);
      onRevoked();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthenticated();
        return;
      }
      if (isStaleMembershipError(error)) {
        await onStaleMembership();
      }
      setErrorMessage(revokeInvitationErrorMessage(error));
    }
  }

  return (
    <>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Popup
          title="Latest invite"
          description={`Created for ${created.invitation.email} in this session.`}
          closeLabel="Close latest invite"
          showCloseButton={!isRevokePending}
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">
              Share the invite link before{' '}
              {formatInvitationExpiration(created.invitation.expiresAt)}.
            </p>
            <TextField
              label="Invite link"
              readOnly
              value={created.inviteUrl}
              className="truncate"
            />
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                onClick={() => {
                  void copyLink();
                }}
              >
                {copied ? 'Copied' : 'Copy invite link'}
              </Button>
              <Button
                type="button"
                variant="subtle"
                className="text-accent-coral-text hover:bg-accent-coral-soft hover:text-accent-coral-text"
                onClick={() => {
                  setRevokeOpen(true);
                }}
              >
                Revoke invite
              </Button>
              <Button
                type="button"
                variant="subtle"
                onClick={() => {
                  handleOpenChange(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Root>

      <Dialog.Root open={revokeOpen} onOpenChange={handleRevokeOpenChange}>
        <Dialog.Popup
          title="Revoke invite?"
          description={`Revoke the invitation sent to ${created.invitation.email}? The link will stop working.`}
          closeLabel="Close revoke invite"
          showCloseButton={!isRevokePending}
        >
          <div className="flex flex-col gap-4">
            {errorMessage ? (
              <Alert variant="danger">{errorMessage}</Alert>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                variant="danger"
                loading={isRevokePending}
                disabled={isRevokePending}
                onClick={() => {
                  void handleConfirmRevoke();
                }}
              >
                Revoke invite
              </Button>
              <Button
                type="button"
                variant="subtle"
                disabled={isRevokePending}
                onClick={() => {
                  handleRevokeOpenChange(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Root>
    </>
  );
}
