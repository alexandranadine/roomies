import { ApiError } from '../platform/api/index.js';
import type { CredentialMode } from './credential-form-schema.js';

const SIGN_IN_GENERIC = 'Email or password is incorrect.';
const SIGN_UP_GENERIC =
  'Couldn’t create this account. Check the details and try again.';
const SIGN_UP_EXISTS = 'Couldn’t create this account. Try signing in.';
const RATE_LIMITED = 'Too many attempts. Try again in a moment.';
const VERIFICATION_DELIVERY =
  'Couldn’t send a verification email. Try again in a moment.';

/**
 * Presentation-only mapping. Does not echo Better Auth messages (those can
 * name accounts) and does not change credential-route security semantics.
 */
export function credentialAuthErrorMessage(
  error: unknown,
  mode: CredentialMode,
): string {
  if (!(error instanceof ApiError)) {
    return mode === 'sign-in' ? SIGN_IN_GENERIC : SIGN_UP_GENERIC;
  }

  if (error.code === 'RATE_LIMITED') {
    return RATE_LIMITED;
  }

  if (mode === 'sign-in') {
    return SIGN_IN_GENERIC;
  }

  if (error.code === 'USER_ALREADY_EXISTS') {
    return SIGN_UP_EXISTS;
  }

  if (
    error.status === 500 ||
    error.code === 'INTERNAL_ERROR' ||
    error.code === 'FAILED_TO_SEND_VERIFICATION_EMAIL'
  ) {
    return VERIFICATION_DELIVERY;
  }

  return SIGN_UP_GENERIC;
}
