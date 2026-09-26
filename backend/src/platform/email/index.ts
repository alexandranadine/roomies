export { TransactionalEmailDeliveryError } from './errors.js';
export { createTransactionalEmailSender } from './create-sender.js';
export {
  createFakeTransactionalEmailSender,
  type CapturedPasswordResetEmail,
  type CapturedVerificationEmail,
  type FakeTransactionalEmailSender,
} from './fake-sender.js';
export { createResendTransactionalEmailSender } from './resend-sender.js';
export { constrainPasswordResetUrl } from './safe-password-reset-url.js';
export { constrainVerificationUrl } from './safe-verification-url.js';
export {
  EMAIL_PASSWORD_RESET_CALLBACK_PATH,
  EMAIL_PASSWORD_RESET_EXPIRES_IN_SECONDS,
  EMAIL_VERIFICATION_CALLBACK_PATH,
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  passwordResetCallbackUrl,
  verificationCallbackUrl,
  type PasswordResetEmailInput,
  type TransactionalEmailSender,
  type VerificationEmailInput,
} from './types.js';
export {
  PASSWORD_RESET_EMAIL_SUBJECT,
  passwordResetEmailHtml,
  passwordResetEmailText,
} from './password-reset-message.js';
export {
  VERIFICATION_EMAIL_SUBJECT,
  verificationEmailHtml,
  verificationEmailText,
} from './verification-message.js';
