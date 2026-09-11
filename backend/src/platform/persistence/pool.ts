import { Pool, type PoolConfig } from 'pg';
import type { AppConfig } from '../config/index.js';

export const DATABASE_POOL_DEFAULTS = Object.freeze({
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  applicationName: 'roomies-backend',
});

type PoolConstructor = new (config: PoolConfig) => Pool;

export type DatabasePoolRuntime = Readonly<{
  pool: Pool;
  /** Idempotently close the process-owned pool. */
  close: () => Promise<void>;
}>;

/**
 * Create the process's only PostgreSQL pool from validated Roomies config.
 * Consumers receive `pool`; only the composition root receives `close`.
 */
export function createDatabasePool(
  config: AppConfig,
  PoolType: PoolConstructor = Pool,
): DatabasePoolRuntime {
  const pool = new PoolType({
    connectionString: config.databaseUrl,
    max: DATABASE_POOL_DEFAULTS.max,
    idleTimeoutMillis: DATABASE_POOL_DEFAULTS.idleTimeoutMillis,
    connectionTimeoutMillis: DATABASE_POOL_DEFAULTS.connectionTimeoutMillis,
    application_name: DATABASE_POOL_DEFAULTS.applicationName,
  });
  let closed = false;

  return Object.freeze({
    pool,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await pool.end();
    },
  });
}
