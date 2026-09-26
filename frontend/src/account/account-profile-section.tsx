import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/16/solid';
import {
  VERIFICATION_EMAIL_SENT,
  VERIFICATION_EMAIL_SENT_TITLE,
  VERIFICATION_SEND_FAILED,
  VERIFICATION_SEND_FAILED_TITLE,
} from '../auth/verification-copy.js';
import {
  Alert,
  Button,
  InitialsAvatar,
  Skeleton,
} from '../components/ui/index.js';
import {
  getInvitationAuthSession,
  invitationAuthSessionQueryKey,
} from '../invitations/auth-session-api.js';
import { sendVerificationEmail } from '../invitations/send-verification-email-api.js';

function sessionDisplayName(name: string | undefined): string | null {
  const trimmed = name?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read-only identity from the existing Better Auth session.
 * No profile photo, no invented display name, no editable fields.
 */
export function AccountProfileSection() {
  const sessionQuery = useQuery({
    queryKey: invitationAuthSessionQueryKey,
    queryFn: ({ signal }) => getInvitationAuthSession(signal),
    retry: false,
  });
  const session = sessionQuery.data;
  const email = session?.user.email ?? '';
  const displayName = sessionDisplayName(session?.user.name);
  const verified = session?.user.emailVerified === true;
  const unverified = session?.user.emailVerified === false;

  const resendVerification = useMutation({
    mutationFn: () => sendVerificationEmail(email),
    retry: false,
  });

  if (sessionQuery.isPending && session === undefined) {
    return (
      <section
        aria-labelledby="account-profile-heading"
        className="rounded-xl border border-border bg-surface px-4 py-4 shadow-card"
      >
        <h2 id="account-profile-heading" className="sr-only">
          Profile
        </h2>
        <div className="flex items-center gap-3" aria-busy="true">
          <Skeleton className="size-14 shrink-0 rounded-full" announced />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-36 rounded-md" />
            <Skeleton className="h-4 w-52 max-w-full rounded-md" />
          </div>
        </div>
      </section>
    );
  }

  if (sessionQuery.isError || session === null || session === undefined) {
    return (
      <section aria-labelledby="account-profile-heading">
        <h2 id="account-profile-heading" className="sr-only">
          Profile
        </h2>
        <Alert variant="danger" title="Couldn’t load your account details">
          <p className="mb-3">Something went wrong. Try again.</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void sessionQuery.refetch();
            }}
          >
            Retry
          </Button>
        </Alert>
      </section>
    );
  }

  const avatarName = displayName ?? email;
  const heading = displayName ?? email;

  return (
    <section
      aria-labelledby="account-profile-heading"
      className="rounded-xl border border-border bg-surface px-4 py-4 shadow-card"
    >
      <div className="flex items-start gap-3">
        <InitialsAvatar
          name={avatarName}
          label={avatarName}
          size="lg"
          className="size-14 text-base"
        />
        <div className="min-w-0 flex-1">
          <h2
            id="account-profile-heading"
            className="min-w-0 break-words text-base font-semibold tracking-tight text-text-primary"
          >
            {heading}
          </h2>
          {displayName !== null ? (
            <p className="mt-0.5 min-w-0 break-words text-sm text-text-secondary">
              {email}
            </p>
          ) : null}
          {verified ? (
            <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand">
              <CheckCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
              Verified
            </p>
          ) : null}
          {unverified ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className="inline-flex items-center gap-1 text-xs font-medium text-accent-coral-text">
                <ExclamationCircleIcon
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                Email not verified
              </p>
              <Button
                type="button"
                variant="secondary"
                className="self-start"
                loading={resendVerification.isPending}
                aria-label={`Resend verification email to ${email}`}
                onClick={() => {
                  if (resendVerification.isPending) {
                    return;
                  }
                  resendVerification.mutate();
                }}
              >
                Resend verification email
              </Button>
              {resendVerification.isSuccess ? (
                <Alert variant="success" title={VERIFICATION_EMAIL_SENT_TITLE}>
                  {VERIFICATION_EMAIL_SENT}
                </Alert>
              ) : null}
              {resendVerification.isError ? (
                <Alert variant="danger" title={VERIFICATION_SEND_FAILED_TITLE}>
                  {VERIFICATION_SEND_FAILED}
                </Alert>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
