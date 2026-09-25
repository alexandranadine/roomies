import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Alert, Button } from '../components/ui/index.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { invitationAuthSessionQueryKey } from '../invitations/auth-session-api.js';
import { signOutSession } from './auth-credential-api.js';

export function SignOutButton() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: signOutSession,
    retry: false,
    onSuccess: async () => {
      clearPrivateHomeQueryState(queryClient);
      queryClient.removeQueries({ queryKey: currentUserQueryKey });
      queryClient.removeQueries({ queryKey: invitationAuthSessionQueryKey });
      await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
      void navigate('/', { replace: true });
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        loading={signOut.isPending}
        onClick={() => {
          signOut.mutate();
        }}
      >
        Sign out
      </Button>
      {signOut.isError ? (
        <Alert variant="danger" title="Couldn’t sign out">
          Try again in a moment.
        </Alert>
      ) : null}
    </div>
  );
}
