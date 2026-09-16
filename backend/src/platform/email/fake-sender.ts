import {
  VERIFICATION_EMAIL_SUBJECT,
  verificationEmailText,
} from './verification-message.js';
import type {
  TransactionalEmailSender,
  VerificationEmailInput,
} from './types.js';

export type CapturedVerificationEmail = Readonly<{
  to: string;
  subject: string;
  text: string;
  verificationUrl: string;
}>;

export type FakeTransactionalEmailSender = TransactionalEmailSender & {
  readonly sent: readonly CapturedVerificationEmail[];
};

/**
 * In-memory adapter for local/test. Never used silently in production.
 */
export function createFakeTransactionalEmailSender(): FakeTransactionalEmailSender {
  const sent: CapturedVerificationEmail[] = [];
  return {
    get sent() {
      return sent;
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
  };
}
