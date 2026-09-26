import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Dialog, TextField } from '../components/ui/index.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { ApiError } from '../platform/api/index.js';
import { deleteAccount } from '../users/delete-account-api.js';

/** Exact phrase required by the UI gate and the frozen API contract. */
export const ACCOUNT_DELETE_CONFIRMATION = 'DELETE' as const;

const LAST_ADMIN_MESSAGE =
  'You’re the only Home Admin in one of your Homes. Make another roommate a Home Admin before deleting your account.';

const GENERIC_FAILURE_MESSAGE =
  'Couldn’t delete your account. Try again in a moment.';

const FORBIDDEN_MESSAGE =
  'You can’t delete your account right now. Try again later.';

export type DeleteAccountDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function errorMessageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === 'LAST_ADMIN_REQUIRED') {
    return LAST_ADMIN_MESSAGE;
  }
  if (error instanceof ApiError && error.status === 403) {
    return FORBIDDEN_MESSAGE;
  }
  return GENERIC_FAILURE_MESSAGE;
}

export function DeleteAccountDialog({
  open,
  onOpenChange,
}: DeleteAccountDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => deleteAccount(ACCOUNT_DELETE_CONFIRMATION),
    retry: false,
  });

  const isPending = deleteMutation.isPending;
  const canSubmit = confirmation === ACCOUNT_DELETE_CONFIRMATION;

  function resetFormState() {
    setConfirmation('');
    setErrorMessage(null);
    deleteMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (isPending && !next) {
      return;
    }
    if (!next) {
      resetFormState();
    }
    onOpenChange(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || isPending) {
      return;
    }

    setErrorMessage(null);
    deleteMutation.reset();

    try {
      await deleteMutation.mutateAsync();
      clearPrivateHomeQueryState(queryClient);
      queryClient.removeQueries({ queryKey: currentUserQueryKey });
      void navigate('/', {
        replace: true,
        state: { accountDeleted: true },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearPrivateHomeQueryState(queryClient);
        queryClient.removeQueries({ queryKey: currentUserQueryKey });
        void navigate('/', {
          replace: true,
          state: { needsFreshSignInForDeletion: true },
        });
        return;
      }
      setErrorMessage(errorMessageFor(error));
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Popup
        title="Delete account"
        description="This permanently ends your Roomies account access."
        closeLabel="Close delete account"
        showCloseButton={!isPending}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          noValidate
        >
          <ul className="m-0 list-disc space-y-2 pl-5 text-sm text-text-secondary">
            <li>You’ll be signed out.</li>
            <li>Your Roomies account access will be removed.</li>
            <li>
              Shared household history stays where it’s still needed for your
              Homes.
            </li>
            <li>Maintenance you personally created will be removed.</li>
            <li>Signing back in won’t restore this account.</li>
          </ul>

          <p className="text-sm text-text-secondary">
            If you’re the only Home Admin in a Home, Roomies may ask you to make
            another roommate a Home Admin before deletion can proceed.
          </p>

          <TextField
            label="Type DELETE to confirm"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={isPending}
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
          />

          {errorMessage ? <Alert variant="danger">{errorMessage}</Alert> : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="submit"
              variant="danger"
              loading={isPending}
              disabled={!canSubmit || isPending}
            >
              Delete my account
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
      </Dialog.Popup>
    </Dialog.Root>
  );
}
