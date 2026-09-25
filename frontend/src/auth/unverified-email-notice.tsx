import { useMutation } from '@tanstack/react-query';
import { Alert, Button } from '../components/ui/index.js';
import { sendVerificationEmail } from '../invitations/send-verification-email-api.js';
import {
  VERIFICATION_EMAIL_SENT,
  VERIFICATION_EMAIL_SENT_TITLE,
  VERIFICATION_SEND_FAILED,
  VERIFICATION_SEND_FAILED_TITLE,
  VERIFY_EMAIL_BEFORE_JOINING,
  VERIFY_EMAIL_BEFORE_JOINING_TITLE,
} from './verification-copy.js';

export function UnverifiedEmailNotice({
  email,
  description = VERIFY_EMAIL_BEFORE_JOINING,
}: {
  email: string;
  description?: string;
}) {
  const resendVerification = useMutation({
    mutationFn: () => sendVerificationEmail(email),
    retry: false,
  });

  return (
    <div className="flex flex-col gap-2">
      <Alert variant="warning" title={VERIFY_EMAIL_BEFORE_JOINING_TITLE}>
        {description}
      </Alert>
      <Button
        variant="secondary"
        loading={resendVerification.isPending}
        onClick={() => {
          resendVerification.mutate();
        }}
      >
        Send verification email
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
  );
}
