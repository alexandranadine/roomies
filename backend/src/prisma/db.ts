import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from './contract.js';
import contractJson from './contract.json' with { type: 'json' };

/**
 * Construct a Prisma Postgres client from an already-validated database URL.
 *
 * Do not read `process.env` here — callers obtain `databaseUrl` from
 * `@roomies/backend` platform config (`parseConfig` / `loadConfig`).
 */
export function createDb(databaseUrl: string) {
  return postgres<Contract>({
    contractJson,
    url: databaseUrl,
  });
}

export type Db = ReturnType<typeof createDb>;
