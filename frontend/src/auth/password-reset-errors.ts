import { ApiError } from '../platform/api/index.js';
import {
  RESET_LINK_SEND_FAILED,
  RESET_PASSWORD_FAILED,
} from './password-reset-copy.js';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from './credential-form-schema.js';

const RATE_LIMITED = 'Too many attempts. Try again in a moment.';
const PASSWORD_LENGTH = `Password must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`;

export function forgotPasswordErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
    return RATE_LIMITED;
  }
  return RESET_LINK_SEND_FAILED;
}

export type ResetPasswordFailure =
  | { kind: 'invalid-token' }
  | { kind: 'password'; message: string }
  | { kind: 'generic'; message: string };

/**
 * Presentation-only mapping. Does not echo Better Auth messages or tokens.
 */
export function resetPasswordFailure(error: unknown): ResetPasswordFailure {
  if (!(error instanceof ApiError)) {
    return { kind: 'generic', message: RESET_PASSWORD_FAILED };
  }

  if (error.code === 'INVALID_TOKEN' || error.code === 'TOKEN_EXPIRED') {
    return { kind: 'invalid-token' };
  }

  if (error.code === 'PASSWORD_TOO_SHORT' || error.code === 'PASSWORD_TOO_LONG') {
    return { kind: 'password', message: PASSWORD_LENGTH };
  }

  if (error.code === 'RATE_LIMITED') {
    return { kind: 'generic', message: RATE_LIMITED };
  }

  return { kind: 'generic', message: RESET_PASSWORD_FAILED };
}

export function isInvalidResetLinkErrorCode(code: string | null): boolean {
  return code !== null && code.trim().length > 0;
}
