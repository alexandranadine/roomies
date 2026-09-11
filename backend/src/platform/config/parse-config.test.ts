import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, parseConfig, type ConfigSource } from './index.js';

const SECRET_DATABASE_URL =
  'postgresql://roomies:super_secret_credential_xyz@127.0.0.1:5432/roomies';

function validDevelopmentEnv(overrides: ConfigSource = {}): ConfigSource {
  return {
    APP_ENV: 'development',
    DATABASE_URL: SECRET_DATABASE_URL,
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
    assert.deepEqual(config.trustedOrigins, [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
    assert.equal(config.trustProxyHops, 0);
    assert.ok(Object.isFrozen(config));
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
    });
    assert.deepEqual(config.trustedOrigins, ['https://app.roomies.example']);
    assert.equal(config.port, 8080);
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
