import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool, type PoolConfig } from 'pg';
import type { AppConfig } from '../config/index.js';
import { createDatabasePool, DATABASE_POOL_DEFAULTS } from './pool.js';

const config: AppConfig = {
  appEnv: 'test',
  port: 3000,
  databaseUrl: 'postgresql://roomies:test@127.0.0.1:5432/roomies_test',
  authBaseUrl: 'http://localhost:3000',
  authSecret: 'roomies_test_secret_32_chars_minimum_value',
  secureAuthCookies: false,
  frontendOrigin: 'http://localhost:5173',
  trustedOrigins: ['http://localhost:5173'],
  trustProxyHops: 0,
};

void describe('createDatabasePool', () => {
  void it('creates one configured pool and closes it exactly once', async () => {
    let constructionCount = 0;
    let endCount = 0;

    class RecordingPool extends Pool {
      constructor(poolConfig: PoolConfig) {
        super(poolConfig);
        constructionCount += 1;
      }

      override end(): Promise<void> {
        endCount += 1;
        return Promise.resolve();
      }
    }

    const runtime = createDatabasePool(config, RecordingPool);

    assert.equal(constructionCount, 1);
    assert.equal(runtime.pool.options.connectionString, config.databaseUrl);
    assert.equal(runtime.pool.options.max, DATABASE_POOL_DEFAULTS.max);
    assert.equal(
      runtime.pool.options.idleTimeoutMillis,
      DATABASE_POOL_DEFAULTS.idleTimeoutMillis,
    );
    assert.equal(
      runtime.pool.options.connectionTimeoutMillis,
      DATABASE_POOL_DEFAULTS.connectionTimeoutMillis,
    );
    assert.equal(
      runtime.pool.options.application_name,
      DATABASE_POOL_DEFAULTS.applicationName,
    );

    await runtime.close();
    await runtime.close();
    assert.equal(endCount, 1);
  });
});
