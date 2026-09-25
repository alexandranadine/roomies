import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../platform/api/index.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import {
  signInWithEmail,
  signOutSession,
  signUpWithEmail,
} from './auth-credential-api.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('credential auth API', () => {
  it('signs up with the frontend verification callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'session', user: { id: 'u1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await signUpWithEmail({
      name: 'Alex',
      email: 'roommate@example.com',
      password: 'test-password-only',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/sign-up/email');
    expect(init.credentials).toBe('include');
    const rawBody = init.body;
    expect(typeof rawBody).toBe('string');
    expect(JSON.parse(rawBody as string)).toEqual({
      name: 'Alex',
      email: 'roommate@example.com',
      password: 'test-password-only',
      callbackURL: `${window.location.origin}/verify-email`,
    });
  });

  it('maps Better Auth sign-in failures without echoing provider copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'INVALID_EMAIL_OR_PASSWORD',
            message: 'Invalid email or password',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    try {
      await signInWithEmail({
        email: 'roommate@example.com',
        password: 'wrong-password-value',
      });
      expect.fail('expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(401);
      expect(apiError.code).toBe('INVALID_EMAIL_OR_PASSWORD');
      expect(apiError.message).toBe('Request failed');
    }
  });

  it('signs out without a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await signOutSession();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/sign-out');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
});
