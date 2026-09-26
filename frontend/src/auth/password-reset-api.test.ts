import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../platform/api/index.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import {
  requestPasswordReset,
  resetPassword,
} from './password-reset-api.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('password reset API', () => {
  it('requests a reset with the frontend reset callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await requestPasswordReset('roommate@example.com');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/request-password-reset');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'roommate@example.com',
      redirectTo: `${window.location.origin}/reset-password`,
    });
  });

  it('resets with Better Auth token and new password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await resetPassword({
      token: 'ResetToken1234567890abcd',
      newPassword: 'replacement-password-ok',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/reset-password');
    expect(JSON.parse(String(init.body))).toEqual({
      token: 'ResetToken1234567890abcd',
      newPassword: 'replacement-password-ok',
    });
  });

  it('maps Better Auth reset failures without echoing provider copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'INVALID_TOKEN',
            message: 'Invalid token secret-body',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    try {
      await resetPassword({
        token: 'expired-token-value',
        newPassword: 'replacement-password-ok',
      });
      expect.fail('expected ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(400);
      expect(apiError.code).toBe('INVALID_TOKEN');
      expect(apiError.message).toBe('Request failed');
    }
  });
});
