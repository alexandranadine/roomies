import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, type ButtonVariant } from '../components/ui/index.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { invitationAuthSessionQueryKey } from '../invitations/auth-session-api.js';
import { signOutSession } from './auth-credential-api.js';

export function SignOutButton({
  children = 'Sign out',
  variant = 'secondary',
  className,
  navigateHome = true,
}: {
  children?: ReactNode;
  variant?: ButtonVariant;
  className?: string;
  /** When false, clear the session and stay on the current route. */
  navigateHome?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: signOutSession,
    retry: false,
    onSuccess: () => {
      clearPrivateHomeQueryState(queryClient);
      queryClient.removeQueries({ queryKey: currentUserQueryKey });
      queryClient.removeQueries({ queryKey: invitationAuthSessionQueryKey });
      if (navigateHome) {
        void navigate('/', { replace: true });
      }
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant={variant}
        className={className}
        loading={signOut.isPending}
        onClick={() => {
          signOut.mutate();
        }}
      >
        {children}
      </Button>
      {signOut.isError ? (
        <Alert variant="danger" title="Couldn’t sign out">
          Try again in a moment.
        </Alert>
      ) : null}
    </div>
  );
}
