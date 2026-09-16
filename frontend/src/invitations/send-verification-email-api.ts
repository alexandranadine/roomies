import { getApiClient } from '../platform/api/index.js';

export const EMAIL_VERIFICATION_CALLBACK_PATH = '/verify-email';

export function verificationCallbackUrl(
  origin = window.location.origin,
): string {
  return `${origin}${EMAIL_VERIFICATION_CALLBACK_PATH}`;
}

/**
 * Better Auth resend. Uses the signed-in session cookie. Do not key this
 * client-side by guessing whether an address is registered.
 */
export async function sendVerificationEmail(email: string): Promise<void> {
  await getApiClient().request({
    method: 'POST',
    path: '/api/auth/send-verification-email',
    body: {
      email,
      callbackURL: verificationCallbackUrl(),
    },
  });
}
