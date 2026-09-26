import { getApiClient } from '../platform/api/index.js';

export const PASSWORD_RESET_CALLBACK_PATH = '/reset-password';

export function passwordResetCallbackUrl(
  origin = window.location.origin,
): string {
  return `${origin}${PASSWORD_RESET_CALLBACK_PATH}`;
}

/**
 * Better Auth native request. Always treat HTTP success as the generic
 * check-email result — do not branch on account existence.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await getApiClient().request({
    method: 'POST',
    path: '/api/auth/request-password-reset',
    body: {
      email,
      redirectTo: passwordResetCallbackUrl(),
    },
  });
}

export async function resetPassword(input: {
  token: string;
  newPassword: string;
}): Promise<void> {
  await getApiClient().request({
    method: 'POST',
    path: '/api/auth/reset-password',
    body: {
      token: input.token,
      newPassword: input.newPassword,
    },
  });
}
