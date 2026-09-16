#!/usr/bin/env node
/**
 * Production/staging/preview migration apply.
 *
 * Applies ONLY committed reviewed Prisma 8 migrations (`prisma db migrate`)
 * then verifies the live schema (`prisma db verify --strict`).
 *
 * Does NOT: db push, schema inference, migration plan, interactive creation,
 * startup migrate, or destructive reset. Does NOT reverse failed migrations.
 *
 * Requires:
 *   APP_ENV=preview|staging|production
 *   MIGRATION_DATABASE_URL= Neon direct / unpooled URL (not -pooler)
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import {
  RELEASE_MIGRATE_PRISMA_COMMANDS,
  PRISMA_RELEASE_SPAWN_SHELL,
  MigrationReleaseError,
  assertReleaseMigratePrismaCommands,
  assertReleaseMigrationTarget,
  prismaReleaseSpawnArgv,
  resolvePrismaCliScript,
} from '../src/platform/persistence/migration-release.js';

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

loadEnv({ path: path.resolve(backendRoot, '../.env'), quiet: true });
loadEnv({
  path: path.resolve(backendRoot, '.env'),
  override: true,
  quiet: true,
});

function runPrisma(args: readonly string[], databaseUrl: string): void {
  const printable = args.map((arg) =>
    arg === databaseUrl ? '<redacted-database-url>' : arg,
  );
  console.log(`> prisma ${printable.join(' ')}`);
  const spawn = prismaReleaseSpawnArgv(
    resolvePrismaCliScript(backendRoot),
    args,
    databaseUrl,
  );
  const result = spawnSync(spawn.command, spawn.args, {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MIGRATION_DATABASE_URL: databaseUrl,
      CI: process.env['CI'] ?? 'true',
    },
    encoding: 'utf8',
    shell: PRISMA_RELEASE_SPAWN_SHELL,
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
    throw new MigrationReleaseError(
      `prisma ${printable.join(' ')} failed with exit ${String(result.status)}`,
    );
  }
}

try {
  const target = assertReleaseMigrationTarget(process.env);
  assertReleaseMigratePrismaCommands(RELEASE_MIGRATE_PRISMA_COMMANDS);
  console.log(`Release migrate APP_ENV=${target.appEnv}`);
  for (const args of RELEASE_MIGRATE_PRISMA_COMMANDS) {
    runPrisma(args, target.migrationDatabaseUrl);
  }
  console.log('Release migrate completed.');
} catch (error: unknown) {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'Release migrate failed';
  console.error(message);
  process.exit(1);
}
