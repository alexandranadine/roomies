import postgres from '@prisma/orm-postgres/runtime';
import type { Pool } from 'pg';
import type { Contract } from './contract.js';
import contractJson from './contract.json' with { type: 'json' };

/**
 * Construct a Prisma Postgres client from the caller-owned process pool.
 *
 * Prisma disconnects its driver on `close()` but only ends pools it created
 * from a URL. Passing `pg` keeps pool lifetime with the process composition
 * root.
 */
export function createDb(pool: Pool) {
  return postgres<Contract>({
    contractJson,
    pg: pool,
  });
}

export type Db = ReturnType<typeof createDb>;
