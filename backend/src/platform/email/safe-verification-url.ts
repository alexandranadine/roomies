import { TransactionalEmailDeliveryError } from './errors.js';

const VERIFY_EMAIL_PATH = '/api/auth/verify-email';

/**
 * Keep Better Auth's token and verify-email path. Rebuild the URL on the
 * canonical API origin and replace callbackURL with the exact frontend return
 * URL so host-header injection and open redirects cannot leak into mail.
 */
export function constrainVerificationUrl(input: {
  url: string;
  token: string;
  authBaseUrl: string;
  callbackUrl: string;
}): string {
  if (input.token.trim().length === 0) {
    throw new TransactionalEmailDeliveryError();
  }

  let parsed: URL;
  let canonical: URL;
  try {
    parsed = new URL(input.url);
    canonical = new URL(input.authBaseUrl);
  } catch {
    throw new TransactionalEmailDeliveryError();
  }

  if (parsed.pathname !== VERIFY_EMAIL_PATH) {
    throw new TransactionalEmailDeliveryError();
  }

  canonical.pathname = VERIFY_EMAIL_PATH;
  canonical.search = '';
  canonical.hash = '';
  canonical.searchParams.set('token', input.token);
  canonical.searchParams.set('callbackURL', input.callbackUrl);
  return canonical.toString();
}
