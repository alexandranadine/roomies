import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, TextField } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { createHomeInvitation } from '../invitations/create-invitation-api.js';
import {
  inviteRoommateFormResolver,
  normalizeInvitationEmail,
  type InviteRoommateFormValues,
} from './invite-roommate-form-schema.js';
import {
  inviteRoommateErrorMessage,
  isStaleMembershipError,
} from './roommates-errors.js';

function formatExpiration(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export type InviteRoommateDialogProps = {
  homeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
  onStaleMembership: () => Promise<void>;
  onUnauthenticated: () => void;
};

export function InviteRoommateDialog({
  homeId,
  open,
  onOpenChange,
  onCreated,
  onStaleMembership,
  onUnauthenticated,
}: InviteRoommateDialogProps) {
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
    }
    onOpenChange(next);
  }

  const submitInvite = handleSubmit(async (values) => {
    if (isPending) {
      return;
    }
    inviteMutation.reset();
    try {
      await inviteMutation.mutateAsync(normalizeInvitationEmail(values.email));
      await onCreated();
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

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Popup
        title="Invite roommate"
        description="Send an invitation to join this Home."
        closeLabel="Close invite roommate"
        showCloseButton={!isPending}
      >
        {created !== undefined ? (
          <div className="flex flex-col gap-4">
            <Alert variant="success" title="Invitation created">
              Sent to {created.invitation.email}. Share the invite link before{' '}
              {formatExpiration(created.invitation.expiresAt)}.
            </Alert>
            <TextField
              label="Invite link"
              readOnly
              value={created.inviteUrl}
              helperText="Anyone with this link can open the invitation."
            />
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(created.inviteUrl);
                }}
              >
                Copy invite link
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
            className="flex flex-col gap-4"
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
