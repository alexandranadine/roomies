import { useMutation } from '@tanstack/react-query';
import { EnvelopeIcon } from '@heroicons/react/24/outline';
import { Alert, Button } from '../components/ui/index.js';
import { sendVerificationEmail } from '../invitations/send-verification-email-api.js';
import { AuthIconWell } from './auth-page-layout.js';
import {
  VERIFICATION_EMAIL_SENT,
  VERIFICATION_EMAIL_SENT_TITLE,
  VERIFICATION_SEND_FAILED,
  VERIFICATION_SEND_FAILED_TITLE,
  VERIFY_EMAIL_FOR_INVITATIONS,
  VERIFY_EMAIL_FOR_INVITATIONS_TITLE,
} from './verification-copy.js';

export type UnverifiedEmailNoticeLayout = 'compact' | 'featured';

export function UnverifiedEmailNotice({
  email,
  title = VERIFY_EMAIL_FOR_INVITATIONS_TITLE,
  description = VERIFY_EMAIL_FOR_INVITATIONS,
  layout = 'compact',
  headingLevel = 'h2',
  showIcon = true,
}: {
  email: string;
  title?: string;
  description?: string;
  layout?: UnverifiedEmailNoticeLayout;
  headingLevel?: 'h1' | 'h2';
  showIcon?: boolean;
}) {
  const resendVerification = useMutation({
    mutationFn: () => sendVerificationEmail(email),
    retry: false,
  });

  const status =
    resendVerification.isSuccess || resendVerification.isError ? (
      <div aria-live="polite">
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
    ) : null;

  const resendButton = (
    <Button
      variant={layout === 'featured' ? 'primary' : 'secondary'}
      className={layout === 'featured' ? 'w-full' : undefined}
      loading={resendVerification.isPending}
      onClick={() => {
        resendVerification.mutate();
      }}
    >
      Resend verification email
    </Button>
  );

  if (layout === 'featured') {
    return (
      <div className="flex flex-col gap-3">
        {showIcon ? (
          <AuthIconWell>
            <EnvelopeIcon className="size-6" />
          </AuthIconWell>
        ) : null}
        <div className="flex flex-col gap-1">
          {headingLevel === 'h1' ? (
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              {title}
            </h1>
          ) : (
            <h2 className="text-xl font-semibold tracking-tight text-text-primary">
              {title}
            </h2>
          )}
          <p className="text-sm leading-snug text-text-secondary">
            {description}
          </p>
          <p className="mt-1 max-w-full break-words text-base font-semibold tracking-tight text-brand">
            {email}
          </p>
        </div>
        {resendButton}
        {status}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Alert variant="info" title={title}>
        <span>{description}</span>{' '}
        <span className="break-words font-medium">{email}</span>
      </Alert>
      {resendButton}
      {status}
    </div>
  );
}
