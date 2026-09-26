/**
 * Purpose-specific transactional mail. Do not add a generic HTML send API.
 */
export type VerificationEmailInput = Readonly<{
  /** Recipient from the Better Auth identity. Never attacker-chosen HTML. */
  to: string;
  /** Better Auth verification URL with a constrained frontend callback. */
  verificationUrl: string;
}>;

export type PasswordResetEmailInput = Readonly<{
  /** Recipient from the Better Auth identity. Never attacker-chosen HTML. */
  to: string;
  /** Frontend reset URL with Better Auth's token as a query parameter. */
  resetUrl: string;
}>;

export type TransactionalEmailSender = {
  sendVerificationEmail(input: VerificationEmailInput): Promise<void>;
  sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void>;
};

export const EMAIL_VERIFICATION_CALLBACK_PATH = '/verify-email';
export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 3600;

export const EMAIL_PASSWORD_RESET_CALLBACK_PATH = '/reset-password';
/** Better Auth 1.7.4 default `resetPasswordTokenExpiresIn`. */
export const EMAIL_PASSWORD_RESET_EXPIRES_IN_SECONDS = 3600;

export function verificationCallbackUrl(frontendOrigin: string): string {
  return `${frontendOrigin}${EMAIL_VERIFICATION_CALLBACK_PATH}`;
}

export function passwordResetCallbackUrl(frontendOrigin: string): string {
  return `${frontendOrigin}${EMAIL_PASSWORD_RESET_CALLBACK_PATH}`;
}
