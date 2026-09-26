import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/types.js';
import type { TransactionalEmailSender } from '../email/index.js';
import { createAuthRuntime } from './runtime.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const AUTH_BASE_URL = 'http://localhost:3000';
const RESET_TOKEN = 'AbCdEfGh1234567890ResetTok';
const RESET_URL = `${AUTH_BASE_URL}/api/auth/reset-password/${RESET_TOKEN}?callbackURL=`;

function unusedPool(): Pool {
  const pool = {
    connect() {
      return Promise.reject(new Error('unit test has no database'));
    },
    end() {
      return Promise.resolve();
    },
    on() {
      return pool;
    },
  };
  return pool as unknown as Pool;
}

function authConfig(): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl: 'postgres://roomies_test:roomies_test@127.0.0.1:5432/roomies_test',
    authBaseUrl: AUTH_BASE_URL,
    authSecret: TEST_SECRET,
    secureAuthCookies: false,
    frontendOrigin: TRUSTED_ORIGIN,
    trustedOrigins: [TRUSTED_ORIGIN],
    trustProxyHops: 0,
    email: { provider: 'fake' },
  };
}

void describe('auth runtime password-reset composition', () => {
  void it('resolves generic success and logs sanitized delivery failure', async () => {
    const email = 'roommate@example.test';
    const sender: TransactionalEmailSender = {
      sendVerificationEmail() {
        return Promise.resolve();
      },
      sendPasswordResetEmail({ resetUrl }) {
        return Promise.reject(
          new Error(`secret-provider-body token=${RESET_TOKEN} url=${resetUrl}`),
        );
      },
    };
    const logs: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };

    try {
      const auth = createAuthRuntime(unusedPool(), authConfig(), {
        emailSender: sender,
      });
      const send = auth.options.emailAndPassword?.sendResetPassword;
      assert.equal(typeof send, 'function');

      await send?.(
        {
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Roommate',
            email,
            emailVerified: false,
            image: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          url: RESET_URL,
          token: RESET_TOKEN,
        },
        new Request(RESET_URL),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    assert.equal(
      logs.some((line) => line.includes('[email] password-reset delivery failed')),
      true,
    );
    const joined = logs.join('\n');
    assert.equal(joined.includes(RESET_TOKEN), false);
    assert.equal(joined.includes(RESET_URL), false);
    assert.equal(joined.includes(email), false);
    assert.equal(joined.includes('secret-provider-body'), false);
    assert.equal(joined.includes('test-password-only'), false);
  });
});
