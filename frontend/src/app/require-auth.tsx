import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { parseCredentialModeFromSearch } from '../auth/auth-entry.js';
import { AuthPageLayout } from '../auth/auth-page-layout.js';
import { CredentialForm } from '../auth/credential-form.js';
import type { CredentialMode } from '../auth/credential-form-schema.js';
import {
  PASSWORD_RESET_SUCCESS_BODY,
  PASSWORD_RESET_SUCCESS_TITLE,
} from '../auth/password-reset-copy.js';
import { UnverifiedEmailNotice } from '../auth/unverified-email-notice.js';
import { PageContainer } from '../components/page-container.js';
import { Alert, Spinner } from '../components/ui/index.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import { isHomeScopedPath } from '../homes/home-nav.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import {
  getInvitationAuthSession,
  invitationAuthSessionQueryKey,
} from '../invitations/auth-session-api.js';
import { PublicLandingPage } from '../landing/public-landing-page.js';
import { ApiError } from '../platform/api/index.js';
import { getCurrentUser } from '../users/current-user-api.js';

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

type AuthLandingLocationState = {
  accountDeleted?: boolean;
  needsFreshSignInForDeletion?: boolean;
  passwordReset?: boolean;
};

function hasPostAuthNotice(state: AuthLandingLocationState | null): boolean {
  return Boolean(
    state?.passwordReset ||
      state?.accountDeleted ||
      state?.needsFreshSignInForDeletion,
  );
}

function shouldShowPublicLanding(
  pathname: string,
  search: string,
  state: AuthLandingLocationState | null,
): boolean {
  return (
    pathname === '/' &&
    parseCredentialModeFromSearch(search) === null &&
    !hasPostAuthNotice(state)
  );
}

function UnauthenticatedAuthCanvas({
  locationState,
  defaultMode,
}: {
  locationState: AuthLandingLocationState | null;
  defaultMode: CredentialMode;
}) {
  return (
    <AuthPageLayout
      title={
        defaultMode === 'sign-up'
          ? 'Create account · Roomies'
          : 'Sign in · Roomies'
      }
    >
      {locationState?.passwordReset ? (
        <Alert variant="success" title={PASSWORD_RESET_SUCCESS_TITLE}>
          {PASSWORD_RESET_SUCCESS_BODY}
        </Alert>
      ) : null}
      {locationState?.accountDeleted ? (
        <Alert variant="info" title="Account deleted">
          Your Roomies account has been deleted.
        </Alert>
      ) : null}
      {locationState?.needsFreshSignInForDeletion ? (
        <Alert variant="info" title="Sign in again">
          Sign in again, then try deleting your account.
        </Alert>
      ) : null}
      <CredentialForm defaultMode={defaultMode} />
    </AuthPageLayout>
  );
}

/**
 * Session gate for product routes. Invitation landing stays outside this wrap.
 * Home data is cleared on authentication loss so a prior Home cannot linger.
 * Signed-out `/` is the closed-alpha landing; `?auth=` reuses CredentialForm.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: currentUserQueryKey,
    queryFn: ({ signal }) => getCurrentUser(signal),
    retry: false,
  });
  const sessionQuery = useQuery({
    queryKey: invitationAuthSessionQueryKey,
    queryFn: ({ signal }) => getInvitationAuthSession(signal),
    retry: false,
    enabled: query.data !== undefined,
  });

  const locationState =
    location.state !== null && typeof location.state === 'object'
      ? (location.state as AuthLandingLocationState)
      : null;

  useEffect(() => {
    if (isUnauthenticated(query.error)) {
      clearPrivateHomeQueryState(queryClient);
    }
  }, [query.error, queryClient]);

  if (query.isPending) {
    return (
      <AuthPageLayout title="Roomies">
        <div className="flex justify-center">
          <Spinner label="Checking your session" />
        </div>
      </AuthPageLayout>
    );
  }

  if (isUnauthenticated(query.error)) {
    if (
      shouldShowPublicLanding(location.pathname, location.search, locationState)
    ) {
      return <PublicLandingPage />;
    }

    return (
      <UnauthenticatedAuthCanvas
        locationState={locationState}
        defaultMode={parseCredentialModeFromSearch(location.search) ?? 'sign-in'}
      />
    );
  }

  if (query.error !== null || query.data === undefined) {
    return (
      <AuthPageLayout title="Roomies">
        <Alert variant="danger" title="Couldn’t confirm your session">
          Try again in a moment.
        </Alert>
      </AuthPageLayout>
    );
  }

  const session = sessionQuery.data;
  const unverified =
    session !== null &&
    session !== undefined &&
    session.user.emailVerified === false;
  const homeScoped = isHomeScopedPath(location.pathname);

  return (
    <>
      {unverified ? (
        homeScoped ? (
          <PageContainer className="pt-3 pb-1">
            <UnverifiedEmailNotice email={session.user.email} />
          </PageContainer>
        ) : (
          <div className="mb-4">
            <UnverifiedEmailNotice email={session.user.email} />
          </div>
        )
      ) : null}
      {children}
    </>
  );
}
