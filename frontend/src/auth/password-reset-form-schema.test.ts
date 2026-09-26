import { describe, expect, it } from 'vitest';
import { resetPasswordFormResolver } from './reset-password-form-schema.js';
import { forgotPasswordFormResolver } from './forgot-password-form-schema.js';

async function resolveReset(values: {
  password: string;
  confirmPassword: string;
}) {
  return resetPasswordFormResolver(values, undefined, {
    fields: {},
    shouldUseNativeValidation: false,
  });
}

describe('password reset form schemas', () => {
  it('accepts a valid forgot-password email', async () => {
    const result = await forgotPasswordFormResolver(
      { email: '  Roommate@Example.COM ' },
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    expect(result.errors).toEqual({});
    expect(result.values).toEqual({ email: 'roommate@example.com' });
  });

  it('blocks confirm-password mismatch client-side', async () => {
    const result = await resolveReset({
      password: 'test-password-only',
      confirmPassword: 'other-password-only',
    });
    expect(result.errors.confirmPassword?.message).toMatch(/do not match/i);
  });

  it('reuses the account-creation password length policy', async () => {
    const result = await resolveReset({
      password: 'short',
      confirmPassword: 'short',
    });
    expect(result.errors.password?.message).toMatch(/8–128/);
  });
});
