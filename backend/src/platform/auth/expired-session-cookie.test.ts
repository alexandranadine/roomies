import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createAuthRuntime } from '../../../auth-runtime/src/index.js';
import {
  appendExpiredAuthSessionCookieAfterCommit,
  expiredAuthSessionSetCookie,
} from './expired-session-cookie.js';

const TEST_SECRET = 'roomies_test_secret_32_chars_minimum_value';

function createRuntime(secureCookies: boolean) {
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

  return createAuthRuntime({
    pool,
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

void describe('appendExpiredAuthSessionCookieAfterCommit', () => {
  void it('appends expiry only after commit', () => {
    const auth = createRuntime(false);
    const committed: string[] = [];
    const aborted: string[] = [];

    appendExpiredAuthSessionCookieAfterCommit(
      {
        append(name, value) {
          committed.push(`${name}: ${value}`);
        },
      },
      'committed',
      auth,
    );
    appendExpiredAuthSessionCookieAfterCommit(
      {
        append(name, value) {
          aborted.push(`${name}: ${value}`);
        },
      },
      'aborted',
      auth,
    );

    assert.equal(aborted.length, 0);
    assert.equal(committed.length, 1);
    const header = committed[0] ?? '';
    assert.match(header, /^Set-Cookie: /);
    const parsed = cookieNameAndAttributes(header.slice('Set-Cookie: '.length));
    assert.equal(parsed.name, 'better-auth.session_token');
    assert.equal(parsed.value, '');
    assert.ok(parsed.attributes.includes('max-age=0'));
    assert.ok(parsed.attributes.includes('httponly'));
    assert.ok(parsed.attributes.includes('path=/'));
    assert.ok(
      parsed.attributes.some((attr) => attr.startsWith('samesite=lax')),
    );
    assert.equal(header.includes(TEST_SECRET), false);
  });

  void it('follows Secure from the live runtime cookie attributes', () => {
    const header = expiredAuthSessionSetCookie(createRuntime(true));
    const parsed = cookieNameAndAttributes(header);
    assert.equal(parsed.name, 'better-auth.session_token');
    assert.ok(parsed.attributes.includes('secure'));
    assert.equal(header.includes(TEST_SECRET), false);
  });
});
