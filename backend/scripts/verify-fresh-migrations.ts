#!/usr/bin/env node
/**
 * Fresh-database migration verification for CI / local test DBs.
 *
 * Starting from an empty PostgreSQL database:
 * 1. Offline: `prisma migration check` (artifact + graph integrity / hashes)
 * 2. Apply the committed migration graph (`prisma db migrate`)
 * 3. Verify marker + schema against the emitted contract (`prisma db verify`)
 *
 * Does NOT:
 * - pre-sign an empty contract before the initial from:null migration
 * - manually delete Prisma markers
 * - depend on a developer's local `roomies` database or its history
 * - mutate on-disk refs (no --advance-ref; `refs/db.json` is already committed)
 *
 * Requires TEST_DATABASE_URL (preferred) or DATABASE_URL pointing at a safe
 * test/CI database name (*_test / *_ci / roomies_test / roomies_ci).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeTestDatabase,
  resolveTestDatabaseUrl,
} from '../src/platform/persistence/test-database.js';
import { verifyAuthPersistence } from './verify-auth-persistence.js';

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function runPrisma(args: string[], databaseUrl: string): void {
  console.log(`> prisma ${args.join(' ')}`);
  // Fixed CLI args only. shell:true keeps `npx` resolution reliable on Windows.
  const result = spawnSync('npx', ['prisma', ...args], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CI: process.env['CI'] ?? 'true',
    },
    encoding: 'utf8',
    shell: true,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `prisma ${args.join(' ')} failed with exit ${String(result.status)}`,
    );
  }
}

const databaseUrl = resolveTestDatabaseUrl();
const parsed = assertSafeTestDatabase(databaseUrl);
console.log(
  `Fresh migration target: ${parsed.hostname}:${parsed.port}/${parsed.database}`,
);

runPrisma(['migration', 'check'], databaseUrl);
runPrisma(['db', 'migrate', '--db', databaseUrl, '--yes'], databaseUrl);
runPrisma(['db', 'verify', '--db', databaseUrl, '--strict'], databaseUrl);
await verifyAuthPersistence(databaseUrl);

console.log(
  'Fresh-database migration and auth persistence verification passed.',
);
