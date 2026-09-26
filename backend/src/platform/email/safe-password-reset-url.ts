import { TransactionalEmailDeliveryError } from './errors.js';
import { EMAIL_PASSWORD_RESET_CALLBACK_PATH } from './types.js';

const RESET_TOKEN_PATTERN = /^[a-zA-Z0-9]{8,64}$/;

/**
 * Keep Better Auth's reset token. Rebuild the link on the trusted frontend
 * reset route so host-header injection and open redirects cannot leak into
 * mail. The emailed URL lands on `/reset-password?token=…`.
 */
export function constrainPasswordResetUrl(input: {
  url: string;
  token: string;
  authBaseUrl: string;
  callbackUrl: string;
}): string {
  if (!RESET_TOKEN_PATTERN.test(input.token)) {
    throw new TransactionalEmailDeliveryError();
  }

  let parsed: URL;
  let callback: URL;
  try {
    parsed = new URL(input.url);
    new URL(input.authBaseUrl);
    callback = new URL(input.callbackUrl);
  } catch {
    throw new TransactionalEmailDeliveryError();
  }

  if (parsed.pathname !== `/api/auth/reset-password/${input.token}`) {
    throw new TransactionalEmailDeliveryError();
  }

  if (callback.pathname !== EMAIL_PASSWORD_RESET_CALLBACK_PATH) {
    throw new TransactionalEmailDeliveryError();
  }

  callback.search = '';
  callback.hash = '';
  callback.searchParams.set('token', input.token);
  return callback.toString();
}
