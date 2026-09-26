import {
  PASSWORD_RESET_EMAIL_SUBJECT,
  passwordResetEmailText,
} from './password-reset-message.js';
import {
  VERIFICATION_EMAIL_SUBJECT,
  verificationEmailText,
} from './verification-message.js';
import type {
  PasswordResetEmailInput,
  TransactionalEmailSender,
  VerificationEmailInput,
} from './types.js';

export type CapturedVerificationEmail = Readonly<{
  to: string;
  subject: string;
  text: string;
  verificationUrl: string;
}>;

export type CapturedPasswordResetEmail = Readonly<{
  to: string;
  subject: string;
  text: string;
  resetUrl: string;
}>;

export type FakeTransactionalEmailSender = TransactionalEmailSender & {
  readonly sent: readonly CapturedVerificationEmail[];
  readonly sentPasswordResets: readonly CapturedPasswordResetEmail[];
};

/**
 * In-memory adapter for local/test. Never used silently in production.
 */
export function createFakeTransactionalEmailSender(): FakeTransactionalEmailSender {
  const sent: CapturedVerificationEmail[] = [];
  const sentPasswordResets: CapturedPasswordResetEmail[] = [];
  return {
    get sent() {
      return sent;
    },
    get sentPasswordResets() {
      return sentPasswordResets;
    },
    sendVerificationEmail(input: VerificationEmailInput) {
      sent.push({
        to: input.to,
        subject: VERIFICATION_EMAIL_SUBJECT,
        text: verificationEmailText(input.verificationUrl),
        verificationUrl: input.verificationUrl,
      });
      return Promise.resolve();
    },
    sendPasswordResetEmail(input: PasswordResetEmailInput) {
      sentPasswordResets.push({
        to: input.to,
        subject: PASSWORD_RESET_EMAIL_SUBJECT,
        text: passwordResetEmailText(input.resetUrl),
        resetUrl: input.resetUrl,
      });
      return Promise.resolve();
    },
  };
}
