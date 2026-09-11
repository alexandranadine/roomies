import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createAuthRuntime } from './index.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';

function callerOwnedPool() {
  let endCount = 0;
  const pool = {
    connect() {
      return Promise.reject(new Error('unit test has no database'));
    },
    end() {
      endCount += 1;
      return Promise.resolve();
    },
    on() {
      return pool;
    },
  } as unknown as Pool;

  return { pool, endCount: () => endCount };
}

void describe('createAuthRuntime', () => {
  void it('uses but never owns the caller pool', async () => {
    const caller = callerOwnedPool();
    const auth = createAuthRuntime({
      pool: caller.pool,
      baseURL: 'https://api.example.test',
      trustedOrigins: ['https://app.example.test'],
      secret: TEST_SECRET,
      secureCookies: true,
    });

    assert.equal(auth.options.database, caller.pool);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(caller.endCount(), 0);
  });

  void it('maps every core model and field to the reviewed auth schema', () => {
    const caller = callerOwnedPool();
    const auth = createAuthRuntime({
      pool: caller.pool,
      baseURL: 'https://api.example.test',
      trustedOrigins: ['https://app.example.test'],
      secret: TEST_SECRET,
      secureCookies: true,
    });

    assert.deepEqual(auth.options.user, {
      modelName: 'auth_identities',
      fields: {
        name: 'name',
        email: 'email',
        emailVerified: 'email_verified',
        image: 'image',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    });
    assert.equal(auth.options.account?.modelName, 'auth_accounts');
    assert.deepEqual(auth.options.account?.fields, {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      scope: 'scope',
      password: 'password',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    });
    assert.equal(auth.options.session?.modelName, 'auth_sessions');
    assert.deepEqual(auth.options.session?.fields, {
      expiresAt: 'expires_at',
      token: 'token',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
    });
    assert.deepEqual(auth.options.verification, {
      modelName: 'auth_verifications',
      fields: {
        identifier: 'identifier',
        value: 'value',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    });
  });

  void it('applies the frozen identity, credential, session, and cookie policy', () => {
    const caller = callerOwnedPool();
    const auth = createAuthRuntime({
      pool: caller.pool,
      baseURL: 'https://api.example.test',
      trustedOrigins: ['https://app.example.test'],
      secret: TEST_SECRET,
      secureCookies: true,
    });

    assert.equal(auth.options.advanced?.database?.generateId, 'uuid');
    assert.equal(auth.options.advanced?.database?.validateSchema, true);
    assert.equal(auth.options.databaseHooks, undefined);
    assert.deepEqual(auth.options.emailAndPassword, {
      enabled: true,
      requireEmailVerification: false,
    });
    assert.deepEqual(auth.options.account?.accountLinking, {
      enabled: false,
      disableImplicitLinking: true,
    });
    assert.equal(auth.options.session?.expiresIn, 60 * 60 * 24 * 7);
    assert.equal(auth.options.session?.updateAge, 60 * 60 * 24);
    assert.equal(auth.options.session?.cookieCache?.enabled, false);
    assert.deepEqual(auth.options.advanced?.defaultCookieAttributes, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    assert.deepEqual(auth.options.plugins, []);
  });

  void it('uses exact supplied base URL/origins and content-free logging', () => {
    const caller = callerOwnedPool();
    const levels: string[] = [];
    const auth = createAuthRuntime({
      pool: caller.pool,
      baseURL: 'https://api.example.test',
      trustedOrigins: ['https://app.example.test'],
      secret: TEST_SECRET,
      secureCookies: true,
      log: (level) => levels.push(level),
    });

    assert.equal(auth.options.baseURL, 'https://api.example.test');
    assert.deepEqual(auth.options.trustedOrigins, ['https://app.example.test']);
    auth.options.logger?.log?.(
      'error',
      'password=session-token',
      new Error('SELECT secret FROM auth_accounts'),
    );
    assert.deepEqual(levels, ['error']);
  });

  void it('contains no pool construction or migration command surface', async () => {
    const source = await readFile(
      new URL('./index.ts', import.meta.url),
      'utf8',
    );
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    assert.doesNotMatch(source, /\bnew\s+Pool\s*\(/);
    assert.doesNotMatch(source, /\bdatabaseHooks\s*:/);
    assert.equal(
      Object.values(packageJson.scripts ?? {}).some((script) =>
        /\b(migrate|generate|schema)\b/i.test(script),
      ),
      false,
    );
  });
});
