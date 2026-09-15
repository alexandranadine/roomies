import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuthRuntime } from './index.js';
import { expiredAuthSessionSetCookie } from './expired-session-cookie.js';
import type { Pool } from 'pg';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';

function callerOwnedPool() {
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
  } as unknown as Pool;
  return pool;
}

function createRuntime(secureCookies: boolean) {
  return createAuthRuntime({
    pool: callerOwnedPool(),
    baseURL: 'http://localhost:3000',
    trustedOrigins: ['http://localhost:5173'],
    secret: TEST_SECRET,
    secureCookies,
  });
}

function cookieNameAndAttributes(setCookie: string): {
  name: string;
  value: string;
  attributes: string[];
} {
  const parts = setCookie.split(';').map((part) => part.trim());
  const pair = parts[0] ?? '';
  const separator = pair.indexOf('=');
  return {
    name: separator >= 0 ? pair.slice(0, separator) : pair,
    value: separator >= 0 ? pair.slice(separator + 1) : '',
    attributes: parts.slice(1).map((part) => part.toLowerCase()),
  };
}

void describe('expiredAuthSessionSetCookie', () => {
  void it('expires the Better Auth session cookie without a database', () => {
    const header = expiredAuthSessionSetCookie(createRuntime(false));
    const parsed = cookieNameAndAttributes(header);

    assert.equal(parsed.name, 'better-auth.session_token');
    assert.equal(parsed.value, '');
    assert.ok(parsed.attributes.includes('max-age=0'));
    assert.ok(parsed.attributes.includes('httponly'));
    assert.ok(parsed.attributes.includes('path=/'));
    assert.ok(
      parsed.attributes.some((attr) => attr.startsWith('samesite=lax')),
    );
    assert.equal(
      parsed.attributes.some((attr) => attr === 'secure'),
      false,
    );
    assert.equal(
      parsed.attributes.some((attr) => attr.startsWith('domain=')),
      false,
    );
  });

  void it('preserves Secure when the runtime is configured for secure cookies', () => {
    const header = expiredAuthSessionSetCookie(createRuntime(true));
    const parsed = cookieNameAndAttributes(header);

    assert.equal(parsed.name, 'better-auth.session_token');
    assert.ok(parsed.attributes.includes('secure'));
    assert.ok(parsed.attributes.includes('httponly'));
    assert.ok(parsed.attributes.includes('path=/'));
    assert.ok(
      parsed.attributes.some((attr) => attr.startsWith('samesite=lax')),
    );
    assert.ok(parsed.attributes.includes('max-age=0'));
  });

  void it('does not embed a session token value', () => {
    const header = expiredAuthSessionSetCookie(createRuntime(false));
    assert.equal(header.includes('session_token='), true);
    assert.equal(header.startsWith('better-auth.session_token=;'), true);
    assert.equal(header.includes(TEST_SECRET), false);
  });
});
