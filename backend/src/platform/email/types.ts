/**
 * Purpose-specific transactional mail. Do not add a generic HTML send API.
 * October: email verification only. Password reset is not wired.
 */
export type VerificationEmailInput = Readonly<{
  /** Recipient from the Better Auth identity. Never attacker-chosen HTML. */
  to: string;
  /** Better Auth verification URL with a constrained frontend callback. */
  verificationUrl: string;
}>;

export type TransactionalEmailSender = {
  sendVerificationEmail(input: VerificationEmailInput): Promise<void>;
};

export const EMAIL_VERIFICATION_CALLBACK_PATH = '/verify-email';
export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 3600;

export function verificationCallbackUrl(frontendOrigin: string): string {
  return `${frontendOrigin}${EMAIL_VERIFICATION_CALLBACK_PATH}`;
}
