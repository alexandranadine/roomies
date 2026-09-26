import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useState } from 'react';
import { Alert, Button, Dialog, TextField } from '../components/ui/index.js';
import {
  createHomeInvitation,
  type CreatedInvitation,
} from '../invitations/create-invitation-api.js';
import { ApiError } from '../platform/api/index.js';
import {
  inviteRoommateFormResolver,
  normalizeInvitationEmail,
  type InviteRoommateFormValues,
} from './invite-roommate-form-schema.js';
import { formatInvitationExpiration } from './invite-format.js';
import {
  inviteRoommateErrorMessage,
  isStaleMembershipError,
} from './roommates-errors.js';

export type InviteRoommateDialogProps = {
  homeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onStaleMembership: () => Promise<void>;
  onUnauthenticated: () => void;
  onInvitationCreated?: (created: CreatedInvitation) => void;
};

export function InviteRoommateDialog({
  homeId,
  open,
  onOpenChange,
  onCreated,
  onStaleMembership,
  onUnauthenticated,
  onInvitationCreated,
}: InviteRoommateDialogProps) {
  const [copied, setCopied] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
    setError,
  } = useForm<InviteRoommateFormValues>({
    resolver: inviteRoommateFormResolver(),
    defaultValues: { email: '' },
  });

  const inviteMutation = useMutation({
    mutationFn: (email: string) => createHomeInvitation({ homeId, email }),
    retry: false,
  });

  const isPending = inviteMutation.isPending;
  const created = inviteMutation.data;

  function handleOpenChange(next: boolean) {
    if (isPending && !next) {
      return;
    }
    if (!next) {
      reset({ email: '' });
      inviteMutation.reset();
      setCopied(false);
    }
    onOpenChange(next);
  }

  const submitInvite = handleSubmit(async (values) => {
    if (isPending) {
      return;
    }
    inviteMutation.reset();
    setCopied(false);
    try {
      const result = await inviteMutation.mutateAsync(
        normalizeInvitationEmail(values.email),
      );
      onInvitationCreated?.(result);
      onCreated();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthenticated();
        return;
      }
      if (isStaleMembershipError(error)) {
        await onStaleMembership();
      }
      setError('root', {
        type: 'server',
        message: inviteRoommateErrorMessage(error),
      });
    }
  });

  async function copyLink() {
    if (created === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(created.inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Popup
        title="Invite roommate"
        description="Send an invitation to join this Home."
        closeLabel="Close invite roommate"
        showCloseButton={!isPending}
      >
        {created !== undefined ? (
          <div className="flex flex-col gap-3">
            <Alert variant="success" title="Invitation created">
              Sent to {created.invitation.email}. Share the invite link before{' '}
              {formatInvitationExpiration(created.invitation.expiresAt)}.
            </Alert>
            <div className="min-w-0 overflow-hidden">
              <TextField
                label="Invite link"
                readOnly
                value={created.inviteUrl}
                className="truncate"
                helperText="Anyone with this link can open the invitation."
              />
            </div>
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
                onClick={() => {
                  handleOpenChange(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              void submitInvite(event);
            }}
            noValidate
          >
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              required
              disabled={isPending}
              invalid={Boolean(errors.email)}
              errorText={errors.email?.message}
              {...register('email')}
            />

            {errors.root?.message ? (
              <Alert variant="danger">{errors.root.message}</Alert>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="submit" loading={isPending} disabled={isPending}>
                Send invitation
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
          </form>
        )}
      </Dialog.Popup>
    </Dialog.Root>
  );
}
