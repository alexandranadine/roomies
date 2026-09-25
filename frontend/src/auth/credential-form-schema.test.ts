import { describe, expect, it } from 'vitest';
import { credentialFormResolver } from './credential-form-schema.js';

async function resolve(
  mode: 'sign-in' | 'sign-up',
  values: { name: string; email: string; password: string },
) {
  return credentialFormResolver(mode)(values, undefined, {
    fields: {},
    shouldUseNativeValidation: false,
  });
}

describe('credential form schema', () => {
  it('accepts a valid sign-in payload', async () => {
    const result = await resolve('sign-in', {
      name: '',
      email: '  Roommate@Example.COM ',
      password: 'test-password-only',
    });
    expect(result.errors).toEqual({});
    expect(result.values).toEqual({
      name: '',
      email: 'roommate@example.com',
      password: 'test-password-only',
    });
  });

  it('requires a name only for sign-up', async () => {
    const signIn = await resolve('sign-in', {
      name: '',
      email: 'roommate@example.com',
      password: 'test-password-only',
    });
    expect(signIn.errors.name).toBeUndefined();

    const signUp = await resolve('sign-up', {
      name: '   ',
      email: 'roommate@example.com',
      password: 'test-password-only',
    });
    expect(signUp.errors.name?.message).toMatch(/enter your name/i);
  });

  it('rejects empty and invalid emails', async () => {
    const empty = await resolve('sign-in', {
      name: '',
      email: '',
      password: 'test-password-only',
    });
    expect(empty.errors.email?.message).toMatch(/enter an email/i);

    const invalid = await resolve('sign-in', {
      name: '',
      email: 'not-an-email',
      password: 'test-password-only',
    });
    expect(invalid.errors.email?.message).toMatch(/valid email/i);
  });

  it('rejects short passwords', async () => {
    const result = await resolve('sign-up', {
      name: 'Alex',
      email: 'roommate@example.com',
      password: 'short',
    });
    expect(result.errors.password?.message).toMatch(/8–128/);
  });
});
