export { TransactionalEmailDeliveryError } from './errors.js';
export { createTransactionalEmailSender } from './create-sender.js';
export {
  createFakeTransactionalEmailSender,
  type CapturedVerificationEmail,
  type FakeTransactionalEmailSender,
} from './fake-sender.js';
export { createResendTransactionalEmailSender } from './resend-sender.js';
export { constrainVerificationUrl } from './safe-verification-url.js';
export {
  EMAIL_VERIFICATION_CALLBACK_PATH,
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  verificationCallbackUrl,
  type TransactionalEmailSender,
  type VerificationEmailInput,
} from './types.js';
export {
  VERIFICATION_EMAIL_SUBJECT,
  verificationEmailHtml,
  verificationEmailText,
} from './verification-message.js';
