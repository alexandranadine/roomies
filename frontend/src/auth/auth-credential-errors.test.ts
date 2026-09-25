import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/api/index.js';
import { credentialAuthErrorMessage } from './auth-credential-errors.js';

describe('credential auth error presentation', () => {
  it('keeps sign-in failures generic', () => {
    expect(
      credentialAuthErrorMessage(
        new ApiError({
          status: 401,
          code: 'INVALID_EMAIL_OR_PASSWORD',
          message: 'User already exists secret-body',
        }),
        'sign-in',
      ),
    ).toBe('Email or password is incorrect.');
  });

  it('does not echo Better Auth account-existence copy on sign-up', () => {
    const message = credentialAuthErrorMessage(
      new ApiError({
        status: 422,
        code: 'USER_ALREADY_EXISTS',
        message: 'User already exists',
      }),
      'sign-up',
    );
    expect(message).toBe('Couldn’t create this account. Try signing in.');
    expect(message).not.toMatch(/already exists/i);
  });

  it('maps verification delivery failure without leaking provider bodies', () => {
    const message = credentialAuthErrorMessage(
      new ApiError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'secret-provider-body token=abc',
      }),
      'sign-up',
    );
    expect(message).toBe(
      'Couldn’t send a verification email. Try again in a moment.',
    );
    expect(message).not.toContain('secret-provider-body');
    expect(message).not.toContain('token=abc');
  });
});
