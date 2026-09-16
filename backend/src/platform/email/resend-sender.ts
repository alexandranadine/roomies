import { TransactionalEmailDeliveryError } from './errors.js';
import {
  VERIFICATION_EMAIL_SUBJECT,
  verificationEmailHtml,
  verificationEmailText,
} from './verification-message.js';
import type {
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
  return {
    async sendVerificationEmail(input: VerificationEmailInput) {
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
            subject: VERIFICATION_EMAIL_SUBJECT,
            text: verificationEmailText(input.verificationUrl),
            html: verificationEmailHtml(input.verificationUrl),
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
    },
  };
}
