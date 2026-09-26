import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/api/index.js';
import {
  forgotPasswordErrorMessage,
  resetPasswordFailure,
} from './password-reset-errors.js';

describe('password reset error presentation', () => {
  it('keeps forgot-password failures generic', () => {
    expect(
      forgotPasswordErrorMessage(
        new ApiError({
          status: 500,
          code: 'INTERNAL_ERROR',
          message: 'secret-provider-body token=abc',
        }),
      ),
    ).toBe('Couldn’t send a reset link. Try again in a moment.');
  });

  it('does not treat unknown email as a distinct UI error', () => {
    expect(
      forgotPasswordErrorMessage(
        new ApiError({
          status: 200,
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        }),
      ),
    ).not.toMatch(/not found|no account|does not exist/i);
  });

  it('maps invalid reset tokens without echoing Better Auth copy', () => {
    const failure = resetPasswordFailure(
      new ApiError({
        status: 400,
        code: 'INVALID_TOKEN',
        message: 'Invalid token secret-body',
      }),
    );
    expect(failure).toEqual({ kind: 'invalid-token' });
  });
});
