import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Dialog } from '../components/ui/index.js';
import type { CreatedInvitation } from '../invitations/create-invitation-api.js';
import { revokeHomeInvitation } from '../invitations/revoke-invitation-api.js';
import { ApiError } from '../platform/api/index.js';
import { formatInvitationExpiration } from './invite-format.js';
import {
  isStaleMembershipError,
  revokeInvitationErrorMessage,
} from './roommates-errors.js';

export type PendingInvitePanelProps = {
  homeId: string;
  created: CreatedInvitation;
  onRevoked: () => void;
  onStaleMembership: () => Promise<void>;
  onUnauthenticated: () => void;
};

export function PendingInvitePanel({
  homeId,
  created,
  onRevoked,
  onStaleMembership,
  onUnauthenticated,
}: PendingInvitePanelProps) {
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

  const isPending = revokeMutation.isPending;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function handleRevokeOpenChange(next: boolean) {
    if (isPending && !next) {
      return;
    }
    if (!next) {
      setErrorMessage(null);
      revokeMutation.reset();
    }
    setRevokeOpen(next);
  }

  async function handleConfirmRevoke() {
    if (isPending) {
      return;
    }
    setErrorMessage(null);
    revokeMutation.reset();
    try {
      await revokeMutation.mutateAsync();
      setRevokeOpen(false);
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
    <section
      aria-labelledby="pending-invite-heading"
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface px-4 py-3 shadow-card"
    >
      <div className="flex flex-col gap-3">
        <div className="min-w-0">
          <h2
            id="pending-invite-heading"
            className="text-sm font-semibold tracking-tight text-text-primary"
          >
            Invite pending
          </h2>
          <p className="mt-0.5 min-w-0 break-words text-xs text-text-secondary">
            Sent to {created.invitation.email}. Share before{' '}
            {formatInvitationExpiration(created.invitation.expiresAt)}.
          </p>
        </div>
        <label className="sr-only" htmlFor="pending-invite-url">
          Invite link
        </label>
        <input
          id="pending-invite-url"
          readOnly
          value={created.inviteUrl}
          className="w-full min-w-0 max-w-full truncate rounded-lg border border-border bg-subtle px-3 py-2 text-sm text-text-secondary"
        />
        <div className="flex flex-wrap gap-2">
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
        </div>
      </div>

      <Dialog.Root open={revokeOpen} onOpenChange={handleRevokeOpenChange}>
        <Dialog.Popup
          title="Revoke invite?"
          description={`Revoke the invitation sent to ${created.invitation.email}? The link will stop working.`}
          closeLabel="Close revoke invite"
          showCloseButton={!isPending}
        >
          <div className="flex flex-col gap-4">
            {errorMessage ? (
              <Alert variant="danger">{errorMessage}</Alert>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                variant="danger"
                loading={isPending}
                disabled={isPending}
                onClick={() => {
                  void handleConfirmRevoke();
                }}
              >
                Revoke invite
              </Button>
              <Button
                type="button"
                variant="subtle"
                disabled={isPending}
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
    </section>
  );
}
