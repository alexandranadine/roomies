import { TransactionalEmailDeliveryError } from './errors.js';
import {
  PASSWORD_RESET_EMAIL_SUBJECT,
  passwordResetEmailHtml,
  passwordResetEmailText,
} from './password-reset-message.js';
import {
  VERIFICATION_EMAIL_SUBJECT,
  verificationEmailHtml,
  verificationEmailText,
} from './verification-message.js';
import type {
  PasswordResetEmailInput,
  TransactionalEmailSender,
  VerificationEmailInput,
} from './types.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;

export type CreateResendTransactionalEmailSenderOptions = Readonly<{
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
}>;

/**
 * Resend HTTPS API. No SDK. Failures never include API bodies, emails, or URLs.
 */
export function createResendTransactionalEmailSender(
  options: CreateResendTransactionalEmailSenderOptions,
): TransactionalEmailSender {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function sendResendEmail(input: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          html: input.html,
        }),
        signal: controller.signal,
      });
    } catch {
      throw new TransactionalEmailDeliveryError();
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new TransactionalEmailDeliveryError();
    }
  }

  return {
    async sendVerificationEmail(input: VerificationEmailInput) {
      await sendResendEmail({
        to: input.to,
        subject: VERIFICATION_EMAIL_SUBJECT,
        text: verificationEmailText(input.verificationUrl),
        html: verificationEmailHtml(input.verificationUrl),
      });
    },
    async sendPasswordResetEmail(input: PasswordResetEmailInput) {
      await sendResendEmail({
        to: input.to,
        subject: PASSWORD_RESET_EMAIL_SUBJECT,
        text: passwordResetEmailText(input.resetUrl),
        html: passwordResetEmailHtml(input.resetUrl),
      });
    },
  };
}
