import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  RELEASE_MIGRATE_PRISMA_COMMANDS,
  PRISMA_RELEASE_SPAWN_SHELL,
  MigrationReleaseError,
  assertReleaseMigratePrismaCommands,
  assertReleaseMigrationTarget,
  prismaReleaseSpawnArgv,
} from './migration-release.js';

const DIRECT_URL =
  'postgresql://roomies:secret@ep-cool.us-west-2.aws.neon.tech/roomies?sslmode=require';

void describe('assertReleaseMigrationTarget', () => {
  void it('accepts production with a direct TLS URL', () => {
    const result = assertReleaseMigrationTarget({
      APP_ENV: 'production',
      MIGRATION_DATABASE_URL: DIRECT_URL,
    });
    assert.equal(result.appEnv, 'production');
    assert.equal(result.migrationDatabaseUrl, DIRECT_URL);
  });

  void it('rejects local APP_ENV values', () => {
    assert.throws(
      () =>
        assertReleaseMigrationTarget({
          APP_ENV: 'development',
          MIGRATION_DATABASE_URL: DIRECT_URL,
        }),
      (error: unknown) => {
        assert.ok(error instanceof MigrationReleaseError);
        assert.match(error.message, /APP_ENV/);
        assert.equal(error.message.includes('secret'), false);
        return true;
      },
    );
  });

  void it('requires MIGRATION_DATABASE_URL', () => {
    assert.throws(
      () =>
        assertReleaseMigrationTarget({
          APP_ENV: 'staging',
          DATABASE_URL: DIRECT_URL,
        }),
      (error: unknown) => {
        assert.ok(error instanceof MigrationReleaseError);
        assert.match(error.message, /MIGRATION_DATABASE_URL is required/);
        assert.equal(error.message.includes('secret'), false);
        return true;
      },
    );
  });

  void it('rejects PgBouncer -pooler hostnames', () => {
    assert.throws(
      () =>
        assertReleaseMigrationTarget({
          APP_ENV: 'production',
          MIGRATION_DATABASE_URL:
            'postgresql://roomies:secret@ep-cool-pooler.us-west-2.aws.neon.tech/roomies?sslmode=require',
        }),
      (error: unknown) => {
        assert.ok(error instanceof MigrationReleaseError);
        assert.match(error.message, /direct \(unpooled\)/);
        assert.equal(error.message.includes('secret'), false);
        return true;
      },
    );
  });

  void it('rejects sslmode=disable', () => {
    assert.throws(
      () =>
        assertReleaseMigrationTarget({
          APP_ENV: 'preview',
          MIGRATION_DATABASE_URL:
            'postgresql://roomies:secret@db.example/roomies?sslmode=disable',
        }),
      /must not disable TLS/,
    );
  });
});

void describe('release migrate Prisma commands', () => {
  void it('applies only reviewed migrate then verify', () => {
    assert.deepEqual(RELEASE_MIGRATE_PRISMA_COMMANDS, [
      ['db', 'migrate', '--yes'],
      ['db', 'verify', '--strict'],
    ]);
    assert.doesNotThrow(() =>
      assertReleaseMigratePrismaCommands(RELEASE_MIGRATE_PRISMA_COMMANDS),
    );
  });

  void it('rejects push, reset, and plan', () => {
    assert.throws(
      () => assertReleaseMigratePrismaCommands([['db', 'push']]),
      /must not run Prisma push/,
    );
    assert.throws(
      () => assertReleaseMigratePrismaCommands([['migrate', 'reset']]),
      /must not run Prisma reset/,
    );
    assert.throws(
      () => assertReleaseMigratePrismaCommands([['migration', 'plan']]),
      /must not run Prisma plan/,
    );
  });

  void it('keeps the release script on migrate+verify only', async () => {
    const source = await readFile(
      new URL('../../../scripts/migrate-release.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /RELEASE_MIGRATE_PRISMA_COMMANDS/);
    assert.match(source, /PRISMA_RELEASE_SPAWN_SHELL/);
    assert.doesNotMatch(
      source,
      /prisma db push|prisma migrate reset|prisma migration plan/,
    );
  });

  void it('invokes node prisma.js with --db as a separate argv entry', () => {
    assert.equal(PRISMA_RELEASE_SPAWN_SHELL, false);
    const url =
      'postgresql://roomies:secret@ep-cool.us-west-2.aws.neon.tech/roomies?sslmode=require&channel_binding=require';
    const spawn = prismaReleaseSpawnArgv(
      '/tmp/prisma.js',
      ['db', 'verify', '--strict'],
      url,
    );
    assert.equal(spawn.command, process.execPath);
    assert.deepEqual(spawn.args, [
      '/tmp/prisma.js',
      'db',
      'verify',
      '--strict',
      '--db',
      url,
    ]);
  });
});
