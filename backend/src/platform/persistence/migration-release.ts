import { createRequire } from 'node:module';
import path from 'node:path';
import { APP_ENVS } from '../config/types.js';

const RELEASE_APP_ENVS = ['preview', 'staging', 'production'] as const;
type ReleaseAppEnv = (typeof RELEASE_APP_ENVS)[number];

/** Prisma CLI argv used by the production migration release command. */
export const RELEASE_MIGRATE_PRISMA_COMMANDS = Object.freeze([
  Object.freeze(['db', 'migrate', '--yes']),
  Object.freeze(['db', 'verify', '--strict']),
] as const);

/**
 * Never spawn the Prisma CLI through a shell. Neon URLs include `&`
 * (`channel_binding`), which cmd.exe treats as a command separator.
 * Windows `npx.cmd` also requires `shell: true`, so invoke `node prisma.js`
 * directly instead.
 */
export const PRISMA_RELEASE_SPAWN_SHELL = false;

export function resolvePrismaCliScript(fromDirectory: string): string {
  const require = createRequire(path.join(fromDirectory, 'package.json'));
  return path.join(
    path.dirname(require.resolve('prisma/package.json')),
    'dist',
    'prisma.js',
  );
}

export function prismaReleaseSpawnArgv(
  prismaJsPath: string,
  prismaArgs: readonly string[],
  databaseUrl: string,
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [prismaJsPath, ...prismaArgs, '--db', databaseUrl],
  };
}

const FORBIDDEN_PRISMA_TOKENS = [
  'push',
  'reset',
  'plan',
  'dev',
  'execute',
  'diff',
];

export class MigrationReleaseError extends Error {
  override readonly name = 'MigrationReleaseError';
}

function isReleaseAppEnv(value: string): value is ReleaseAppEnv {
  return (RELEASE_APP_ENVS as readonly string[]).includes(value);
}

function hostnameFromPostgresUrl(urlValue: string): string | undefined {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Validate the release-only migration target without echoing secrets.
 *
 * Production/staging/preview must use `MIGRATION_DATABASE_URL` pointing at a
 * direct (non-pooler) Postgres host. Prisma 8 `db migrate` is not applied
 * through PgBouncer transaction pooling.
 */
export function assertReleaseMigrationTarget(source: {
  APP_ENV?: string | undefined;
  MIGRATION_DATABASE_URL?: string | undefined;
  DATABASE_URL?: string | undefined;
}): { appEnv: ReleaseAppEnv; migrationDatabaseUrl: string } {
  const appEnvRaw = source.APP_ENV?.trim() ?? '';
  if (!isReleaseAppEnv(appEnvRaw)) {
    const allowed = RELEASE_APP_ENVS.join(', ');
    const known = (APP_ENVS as readonly string[]).includes(appEnvRaw)
      ? appEnvRaw
      : 'missing or unrecognized';
    throw new MigrationReleaseError(
      `Release migrate requires APP_ENV to be one of: ${allowed} (received ${known})`,
    );
  }

  const migrationDatabaseUrl = source.MIGRATION_DATABASE_URL?.trim() ?? '';
  if (migrationDatabaseUrl.length === 0) {
    throw new MigrationReleaseError(
      'MIGRATION_DATABASE_URL is required for release migrate (Neon direct / unpooled URL)',
    );
  }

  const hostname = hostnameFromPostgresUrl(migrationDatabaseUrl);
  if (hostname === undefined) {
    throw new MigrationReleaseError(
      'MIGRATION_DATABASE_URL must be a postgresql:// URL',
    );
  }
  if (hostname.includes('-pooler.')) {
    throw new MigrationReleaseError(
      'MIGRATION_DATABASE_URL must be the direct (unpooled) host, not a -pooler hostname',
    );
  }

  const sslMode = sslModeFromUrl(migrationDatabaseUrl);
  if (sslMode === 'disable') {
    throw new MigrationReleaseError(
      'MIGRATION_DATABASE_URL must not disable TLS (sslmode=disable)',
    );
  }

  return { appEnv: appEnvRaw, migrationDatabaseUrl };
}

function sslModeFromUrl(urlValue: string): string | undefined {
  try {
    const parsed = new URL(urlValue);
    const sslMode = parsed.searchParams.get('sslmode');
    return sslMode?.trim().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Guard against accidental mutation of the reviewed migrate/verify argv. */
export function assertReleaseMigratePrismaCommands(
  commands: readonly (readonly string[])[],
): void {
  for (const args of commands) {
    const joined = args.join(' ').toLowerCase();
    for (const token of FORBIDDEN_PRISMA_TOKENS) {
      if (args.includes(token) || joined.includes(` ${token} `)) {
        throw new MigrationReleaseError(
          `Release migrate must not run Prisma ${token}`,
        );
      }
    }
    if (args[0] === 'db' && args[1] !== 'migrate' && args[1] !== 'verify') {
      throw new MigrationReleaseError(
        'Release migrate may only run prisma db migrate and prisma db verify',
      );
    }
  }
}
