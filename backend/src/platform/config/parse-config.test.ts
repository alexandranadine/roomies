import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, parseConfig, type ConfigSource } from './index.js';

const SECRET_DATABASE_URL =
  'postgresql://roomies:super_secret_credential_xyz@127.0.0.1:5432/roomies';
const VALID_AUTH_SECRET = 'roomies_test_secret_32_chars_minimum_value';

function validDevelopmentEnv(overrides: ConfigSource = {}): ConfigSource {
  return {
    APP_ENV: 'development',
    DATABASE_URL: SECRET_DATABASE_URL,
    AUTH_SECRET: VALID_AUTH_SECRET,
    PORT: '3000',
    TRUSTED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
    ...overrides,
  };
}

void describe('parseConfig', () => {
  void it('accepts a valid development configuration', () => {
    const config = parseConfig(validDevelopmentEnv());

    assert.equal(config.appEnv, 'development');
    assert.equal(config.port, 3000);
    assert.equal(config.databaseUrl, SECRET_DATABASE_URL);
    assert.equal(config.authBaseUrl, 'http://localhost:3000');
    assert.equal(config.authSecret, VALID_AUTH_SECRET);
    assert.equal(config.secureAuthCookies, false);
    assert.equal(config.frontendOrigin, 'http://localhost:5173');
    assert.deepEqual(config.trustedOrigins, [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
    assert.equal(config.trustProxyHops, 0);
    assert.equal(config.processMode, 'combined');
    assert.equal(config.recurrencePollIntervalMs, 30_000);
    assert.ok(Object.isFrozen(config));
  });

  void it('defaults PROCESS_MODE to combined when absent', () => {
    const config = parseConfig(
      validDevelopmentEnv({ PROCESS_MODE: undefined }),
    );
    assert.equal(config.processMode, 'combined');
  });

  void it('accepts explicit PROCESS_MODE values', () => {
    assert.equal(
      parseConfig(validDevelopmentEnv({ PROCESS_MODE: 'web' })).processMode,
      'web',
    );
    assert.equal(
      parseConfig(validDevelopmentEnv({ PROCESS_MODE: 'worker' })).processMode,
      'worker',
    );
    assert.equal(
      parseConfig(validDevelopmentEnv({ PROCESS_MODE: 'combined' }))
        .processMode,
      'combined',
    );
  });

  void it('rejects invalid PROCESS_MODE before runtime starts', () => {
    assert.throws(
      () => parseConfig(validDevelopmentEnv({ PROCESS_MODE: 'daemon' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /PROCESS_MODE/);
        assert.match(error.message, /web, worker, combined/);
        return true;
      },
    );

    assert.throws(
      () => parseConfig(validDevelopmentEnv({ PROCESS_MODE: 'WEB' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /PROCESS_MODE/);
        return true;
      },
    );
  });

  void it('defaults RECURRENCE_POLL_INTERVAL_MS to 30000', () => {
    const config = parseConfig(
      validDevelopmentEnv({ RECURRENCE_POLL_INTERVAL_MS: undefined }),
    );
    assert.equal(config.recurrencePollIntervalMs, 30_000);
  });

  void it('accepts RECURRENCE_POLL_INTERVAL_MS within the operational range', () => {
    assert.equal(
      parseConfig(validDevelopmentEnv({ RECURRENCE_POLL_INTERVAL_MS: '1000' }))
        .recurrencePollIntervalMs,
      1000,
    );
    assert.equal(
      parseConfig(
        validDevelopmentEnv({ RECURRENCE_POLL_INTERVAL_MS: '300000' }),
      ).recurrencePollIntervalMs,
      300_000,
    );
  });

  void it('rejects RECURRENCE_POLL_INTERVAL_MS outside 1000-300000', () => {
    for (const value of ['999', '300001', 'not-a-number', '30.5', '-1000']) {
      assert.throws(
        () =>
          parseConfig(
            validDevelopmentEnv({ RECURRENCE_POLL_INTERVAL_MS: value }),
          ),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /RECURRENCE_POLL_INTERVAL_MS/);
          return true;
        },
      );
    }
  });

  void it('defaults TRUST_PROXY hop count to 0 when unset', () => {
    const config = parseConfig(validDevelopmentEnv({ TRUST_PROXY: undefined }));
    assert.equal(config.trustProxyHops, 0);
  });

  void it('accepts an explicit TRUST_PROXY hop count', () => {
    const config = parseConfig(validDevelopmentEnv({ TRUST_PROXY: '1' }));
    assert.equal(config.trustProxyHops, 1);
  });

  void it('rejects boolean TRUST_PROXY values', () => {
    assert.throws(
      () => parseConfig(validDevelopmentEnv({ TRUST_PROXY: 'true' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TRUST_PROXY/);
        assert.match(error.message, /hop count|boolean/i);
        return true;
      },
    );
  });

  void it('rejects invalid TRUST_PROXY values', () => {
    assert.throws(
      () => parseConfig(validDevelopmentEnv({ TRUST_PROXY: 'not-a-number' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TRUST_PROXY/);
        return true;
      },
    );

    assert.throws(
      () => parseConfig(validDevelopmentEnv({ TRUST_PROXY: '99' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TRUST_PROXY/);
        return true;
      },
    );
  });

  void it('applies development localhost origin defaults when TRUSTED_ORIGINS is omitted', () => {
    const config = parseConfig(
      validDevelopmentEnv({ TRUSTED_ORIGINS: undefined }),
    );
    assert.deepEqual(config.trustedOrigins, [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  void it('defaults PORT to 3000 when unset', () => {
    const config = parseConfig(validDevelopmentEnv({ PORT: undefined }));
    assert.equal(config.port, 3000);
  });

  void it('fails when DATABASE_URL is missing', () => {
    assert.throws(
      () => parseConfig(validDevelopmentEnv({ DATABASE_URL: undefined })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /DATABASE_URL is required/);
        assert.equal(
          error.message.includes('super_secret_credential_xyz'),
          false,
        );
        return true;
      },
    );
  });

  void it('fails when AUTH_SECRET is missing, short, or the insecure default', () => {
    for (const authSecret of [
      undefined,
      'too-short',
      'a'.repeat(32),
      'better-auth-secret-123456789',
      'replace_with_a_random_secret_of_at_least_32_characters',
    ]) {
      assert.throws(
        () => parseConfig(validDevelopmentEnv({ AUTH_SECRET: authSecret })),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /AUTH_SECRET/);
          if (authSecret) {
            assert.equal(error.message.includes(authSecret), false);
          }
          return true;
        },
      );
    }

    assert.throws(
      () =>
        parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: SECRET_DATABASE_URL,
          AUTH_BASE_URL: 'https://api.example.test',
          AUTH_SECRET: 'replace_with_a_random_secret_of_at_least_32_characters',
          TRUSTED_ORIGINS: 'https://app.example.test',
        }),
      /AUTH_SECRET/,
    );
  });

  void it('fails on invalid APP_ENV', () => {
    assert.throws(
      () => parseConfig(validDevelopmentEnv({ APP_ENV: 'local' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /APP_ENV/);
        assert.match(error.message, /development/);
        return true;
      },
    );
  });

  void it('fails on invalid PORT', () => {
    assert.throws(
      () => parseConfig(validDevelopmentEnv({ PORT: 'not-a-port' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /PORT/);
        return true;
      },
    );

    assert.throws(
      () => parseConfig(validDevelopmentEnv({ PORT: '70000' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /PORT/);
        return true;
      },
    );

    assert.throws(
      () => parseConfig(validDevelopmentEnv({ PORT: '0' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /PORT/);
        return true;
      },
    );
  });

  void it('fails on malformed allowed origin', () => {
    assert.throws(
      () => parseConfig(validDevelopmentEnv({ TRUSTED_ORIGINS: 'not a url' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TRUSTED_ORIGINS/);
        return true;
      },
    );

    assert.throws(
      () => parseConfig(validDevelopmentEnv({ TRUSTED_ORIGINS: '*' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TRUSTED_ORIGINS|wildcard/i);
        return true;
      },
    );

    assert.throws(
      () =>
        parseConfig(
          validDevelopmentEnv({
            TRUSTED_ORIGINS: 'http://localhost:5173/app',
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TRUSTED_ORIGINS|path/i);
        return true;
      },
    );
  });

  void it('does not apply localhost origin defaults in production', () => {
    assert.throws(
      () =>
        parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: SECRET_DATABASE_URL,
          AUTH_SECRET: VALID_AUTH_SECRET,
          PORT: '8080',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /TRUSTED_ORIGINS is required/);
        assert.match(error.message, /APP_ENV=production/);
        assert.equal(error.message.includes('http://localhost'), false);
        assert.equal(error.message.includes('127.0.0.1'), false);
        return true;
      },
    );

    for (const appEnv of ['preview', 'staging'] as const) {
      assert.throws(
        () =>
          parseConfig({
            APP_ENV: appEnv,
            DATABASE_URL: SECRET_DATABASE_URL,
            AUTH_SECRET: VALID_AUTH_SECRET,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /TRUSTED_ORIGINS is required/);
          return true;
        },
      );
    }
  });

  void it('accepts explicit production origins without localhost defaults', () => {
    const config = parseConfig({
      APP_ENV: 'production',
      DATABASE_URL: SECRET_DATABASE_URL,
      PORT: '8080',
      TRUSTED_ORIGINS: 'https://app.roomies.example',
      FRONTEND_ORIGIN: 'https://app.roomies.example',
      AUTH_BASE_URL: 'https://api.roomies.example',
      AUTH_SECRET: VALID_AUTH_SECRET,
    });
    assert.deepEqual(config.trustedOrigins, ['https://app.roomies.example']);
    assert.equal(config.frontendOrigin, 'https://app.roomies.example');
    assert.equal(config.authBaseUrl, 'https://api.roomies.example');
    assert.equal(config.secureAuthCookies, true);
    assert.equal(config.port, 8080);
  });

  void it('requires an explicit valid auth base URL outside local environments', () => {
    assert.throws(
      () =>
        parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: SECRET_DATABASE_URL,
          AUTH_SECRET: VALID_AUTH_SECRET,
          TRUSTED_ORIGINS: 'https://app.example',
        }),
      /AUTH_BASE_URL is required/,
    );

    assert.throws(
      () =>
        parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: SECRET_DATABASE_URL,
          AUTH_SECRET: VALID_AUTH_SECRET,
          AUTH_BASE_URL: 'https://api.example/path',
          TRUSTED_ORIGINS: 'https://app.example',
        }),
      /AUTH_BASE_URL is invalid/,
    );
  });

  void it('defaults FRONTEND_ORIGIN in development when omitted', () => {
    const config = parseConfig(
      validDevelopmentEnv({ FRONTEND_ORIGIN: undefined }),
    );
    assert.equal(config.frontendOrigin, 'http://localhost:5173');
  });

  void it('uses FRONTEND_ORIGIN independently of TRUSTED_ORIGINS order', () => {
    const config = parseConfig(
      validDevelopmentEnv({
        FRONTEND_ORIGIN: 'https://app.example.test',
        TRUSTED_ORIGINS:
          'http://127.0.0.1:5173,http://localhost:5173,https://app.example.test',
      }),
    );
    assert.equal(config.frontendOrigin, 'https://app.example.test');
    assert.deepEqual(config.trustedOrigins, [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'https://app.example.test',
    ]);
  });

  void it('normalizes FRONTEND_ORIGIN trailing slashes', () => {
    const config = parseConfig(
      validDevelopmentEnv({
        FRONTEND_ORIGIN: 'https://app.example.test/',
      }),
    );
    assert.equal(config.frontendOrigin, 'https://app.example.test');
  });

  void it('fails on malformed FRONTEND_ORIGIN', () => {
    assert.throws(
      () => parseConfig(validDevelopmentEnv({ FRONTEND_ORIGIN: 'not a url' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /FRONTEND_ORIGIN/);
        return true;
      },
    );
  });

  void it('requires FRONTEND_ORIGIN outside local environments', () => {
    assert.throws(
      () =>
        parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: SECRET_DATABASE_URL,
          AUTH_SECRET: VALID_AUTH_SECRET,
          AUTH_BASE_URL: 'https://api.example.test',
          TRUSTED_ORIGINS: 'https://app.example.test',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /FRONTEND_ORIGIN is required/);
        return true;
      },
    );
  });

  void it('normalizes origin trailing slashes and deduplicates', () => {
    const config = parseConfig(
      validDevelopmentEnv({
        TRUSTED_ORIGINS:
          'http://localhost:5173/, http://localhost:5173, https://App.Example:443',
      }),
    );
    assert.deepEqual(config.trustedOrigins, [
      'http://localhost:5173',
      'https://app.example',
    ]);
  });

  void it('does not dump secret values into validation error text', () => {
    const secret = 'super_secret_credential_xyz';
    const databaseUrl = `postgresql://roomies:${secret}@db.example:5432/roomies`;

    assert.throws(
      () =>
        parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: databaseUrl,
          PORT: 'bad',
          TRUSTED_ORIGINS: 'https://app.example',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(databaseUrl), false);
        assert.match(error.message, /PORT/);
        return true;
      },
    );

    assert.throws(
      () =>
        parseConfig({
          DATABASE_URL: databaseUrl,
          APP_ENV: 'not-real',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(databaseUrl), false);
        assert.match(error.message, /APP_ENV/);
        return true;
      },
    );

    assert.throws(
      () =>
        parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: undefined,
          TRUSTED_ORIGINS: 'https://app.example',
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /DATABASE_URL is required/);
        assert.equal(error.message.includes('postgresql://'), false);
        return true;
      },
    );
  });
});
