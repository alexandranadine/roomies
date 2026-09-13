import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createHomeArchiveWriter } from '../../domains/homes/archive-home.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { InvitationPersistenceError } from '../../domains/invitations/errors.js';
import { createInvitationHomeArchiveCleanup } from '../../domains/invitations/home-archive-cleanup.js';
import { createInvitationRepository } from '../../domains/invitations/repository.js';
import { createMembershipEndingWriter } from '../../domains/memberships/update-active-membership-ended-at.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createOutboxWriter } from '../../platform/events/outbox-writer.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { systemClock } from '../../platform/time/clock.js';
import { createApplyMembershipEndingWithinHomeStructure } from './end-membership-within-home-structure.js';
import {
  createArchiveFinalMemberHome,
  type ArchiveFinalMemberHomeDependencies,
} from './archive-final-member-home.js';
import { createCreateInvitationFromPool } from './create-invitation.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();
const ARCHIVED_AT = new Date('2026-10-04T12:00:00.000Z');
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-10-08T00:00:00.000Z');
const EXPIRED_AT = new Date('2026-10-03T00:00:00.000Z');
const PRIOR_AT = new Date('2026-10-02T00:00:00.000Z');

function testConfig(databaseUrl: string): AppConfig {
  return {
    appEnv: 'test',
    port: 3000,
    databaseUrl,
    authBaseUrl: 'http://localhost:3000',
    authSecret: 'roomies_test_secret_32_chars_minimum_value',
    secureAuthCookies: false,
    frontendOrigin: 'http://localhost:5173',
    trustedOrigins: ['http://localhost:5173'],
    trustProxyHops: 0,
  };
}

function nextEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
}): ActiveHomeActor {
  return { ...input, role: 'ADMIN' };
}

type InvitationRow = {
  id: string;
  home_id: string;
  invited_email: string;
  token_hash: Uint8Array;
  created_by_membership_id: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_membership_id: string | null;
  revoked_at: Date | null;
  revocation_cause: string | null;
};

async function insertInvitation(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    email: string;
    createdByMembershipId: string;
    createdAt?: Date;
    expiresAt?: Date;
    acceptedAt?: Date;
    acceptedMembershipId?: string;
    revokedAt?: Date;
    revocationCause?: 'ADMIN_REVOKED' | 'HOME_ARCHIVED';
  },
): Promise<InvitationRow> {
  await pool.query(
    `INSERT INTO invitations (
       id, home_id, invited_email, token_hash, created_by_membership_id,
       created_at, expires_at, accepted_at, accepted_membership_id,
       revoked_at, revocation_cause
     ) VALUES (
       $1::uuid, $2::uuid, $3::text, $4::bytea, $5::uuid,
       $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::uuid,
       $10::timestamptz, $11::text
     )`,
    [
      input.id,
      input.homeId,
      normalizeEmail(input.email),
      randomBytes(32),
      input.createdByMembershipId,
      input.createdAt ?? CREATED_AT,
      input.expiresAt ?? EXPIRES_AT,
      input.acceptedAt ?? null,
      input.acceptedMembershipId ?? null,
      input.revokedAt ?? null,
      input.revocationCause ?? null,
    ],
  );
  return loadInvitation(pool, input.id);
}

async function loadInvitation(
  pool: Pool,
  invitationId: string,
): Promise<InvitationRow> {
  const result = await pool.query<InvitationRow>(
    `SELECT id, home_id, invited_email, token_hash, created_by_membership_id,
            created_at, expires_at, accepted_at, accepted_membership_id,
            revoked_at, revocation_cause
     FROM invitations WHERE id = $1`,
    [invitationId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function insertHome(pool: Pool, name: string) {
  const homeId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    userId,
  ]);
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [homeId, name],
  );
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
     VALUES ($1, $2, $3, 'ADMIN', NULL)`,
    [membershipId, homeId, userId],
  );
  return { homeId, userId, membershipId };
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  await pool.query(
    'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
    [input.homeIds],
  );
  await pool.query('DELETE FROM invitations WHERE home_id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM memberships WHERE home_id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    input.userIds,
  ]);
}

type CommandOverrides = Partial<
  Pick<
    ArchiveFinalMemberHomeDependencies,
    | 'invitationRevoker'
    | 'applyMembershipEnding'
    | 'homeArchive'
    | 'outbox'
    | 'lockHomeStructure'
    | 'clock'
  >
>;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createCommand(pool: Pool, overrides: CommandOverrides = {}) {
  return createArchiveFinalMemberHome({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    clock: { now: () => ARCHIVED_AT },
    invitationRevoker: createInvitationHomeArchiveCleanup(
      createInvitationRepository(pool),
    ),
    applyMembershipEnding: createApplyMembershipEndingWithinHomeStructure({
      taskCleanup: {
        handleMembershipEnded() {
          return Promise.resolve();
        },
      },
      supplyCleanup: {
        handleMembershipEnded() {
          return Promise.resolve();
        },
      },
      membershipEnding: createMembershipEndingWriter(),
    }),
    homeArchive: createHomeArchiveWriter(),
    outbox: createOutboxWriter(),
    ids: { next: nextEventId },
    ...overrides,
  });
}

async function seedMixedInvitations(pool: Pool, name: string) {
  const home = await insertHome(pool, name);
  const endedUserId = randomUUID();
  const endedMembershipId = randomUUID();
  try {
    await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
      endedUserId,
    ]);
    await pool.query(
      `INSERT INTO memberships (id, home_id, user_id, role, ended_at)
       VALUES ($1, $2, $3, 'ROOMMATE', $4)`,
      [endedMembershipId, home.homeId, endedUserId, PRIOR_AT],
    );

    const pendingLaterId = randomUUID();
    const pendingEarlierId = randomUUID();
    const pendingThirdId = randomUUID();
    const expiredId = randomUUID();
    const adminRevokedId = randomUUID();
    const acceptedId = randomUUID();
    const pendingLater = await insertInvitation(pool, {
      id: pendingLaterId,
      homeId: home.homeId,
      email: `later-${home.homeId}@example.com`,
      createdByMembershipId: home.membershipId,
    });
    const pendingEarlier = await insertInvitation(pool, {
      id: pendingEarlierId,
      homeId: home.homeId,
      email: `earlier-${home.homeId}@example.com`,
      createdByMembershipId: home.membershipId,
    });
    const pendingThird = await insertInvitation(pool, {
      id: pendingThirdId,
      homeId: home.homeId,
      email: `third-${home.homeId}@example.com`,
      createdByMembershipId: home.membershipId,
    });
    const expired = await insertInvitation(pool, {
      id: expiredId,
      homeId: home.homeId,
      email: `expired-${home.homeId}@example.com`,
      createdByMembershipId: home.membershipId,
      expiresAt: EXPIRED_AT,
    });
    const adminRevoked = await insertInvitation(pool, {
      id: adminRevokedId,
      homeId: home.homeId,
      email: `revoked-${home.homeId}@example.com`,
      createdByMembershipId: home.membershipId,
      revokedAt: PRIOR_AT,
      revocationCause: 'ADMIN_REVOKED',
    });
    const accepted = await insertInvitation(pool, {
      id: acceptedId,
      homeId: home.homeId,
      email: `accepted-${home.homeId}@example.com`,
      createdByMembershipId: home.membershipId,
      acceptedAt: PRIOR_AT,
      acceptedMembershipId: endedMembershipId,
    });

    return {
      ...home,
      userIds: [home.userId, endedUserId],
      pending: [pendingEarlier, pendingLater, pendingThird],
      expired,
      adminRevoked,
      accepted,
    };
  } catch (error) {
    await cleanup(pool, {
      homeIds: [home.homeId],
      userIds: [home.userId, endedUserId],
    });
    throw error;
  }
}

void describe('archiveFinalMemberHome invitation cleanup PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const parsed = parseDatabaseUrl(resolveSafeDedicatedTestDatabaseUrl());
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    },
  );

  void it(
    'revokes only effective pending invitations atomically with Home archive',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const other = await insertHome(database.pool, 'Other Home');
      const otherPending = await insertInvitation(database.pool, {
        id: randomUUID(),
        homeId: other.homeId,
        email: `other-${other.homeId}@example.com`,
        createdByMembershipId: other.membershipId,
      });
      const seed = await seedMixedInvitations(
        database.pool,
        'Archive Invitation Mix',
      );
      try {
        await createCommand(database.pool)({
          homeId: seed.homeId,
          actor: actor(seed),
        });

        for (const pending of seed.pending) {
          const after = await loadInvitation(database.pool, pending.id);
          assert.deepEqual(after.revoked_at, ARCHIVED_AT);
          assert.equal(after.revocation_cause, 'HOME_ARCHIVED');
          assert.equal(after.accepted_at, null);
          assert.equal(after.accepted_membership_id, null);
          assert.equal(after.invited_email, pending.invited_email);
          assert.equal(
            after.created_by_membership_id,
            pending.created_by_membership_id,
          );
          assert.deepEqual(after.created_at, pending.created_at);
          assert.deepEqual(after.expires_at, pending.expires_at);
          assert.deepEqual([...after.token_hash], [...pending.token_hash]);
        }

        assert.deepEqual(
          await loadInvitation(database.pool, seed.expired.id),
          seed.expired,
        );
        assert.deepEqual(
          await loadInvitation(database.pool, seed.adminRevoked.id),
          seed.adminRevoked,
        );
        assert.equal(
          (await loadInvitation(database.pool, seed.adminRevoked.id))
            .revocation_cause,
          'ADMIN_REVOKED',
        );
        assert.deepEqual(
          await loadInvitation(database.pool, seed.accepted.id),
          seed.accepted,
        );
        assert.deepEqual(
          await loadInvitation(database.pool, otherPending.id),
          otherPending,
        );

        const home = await database.pool.query<{ archived_at: Date }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [seed.homeId],
        );
        assert.deepEqual(home.rows[0]?.archived_at, ARCHIVED_AT);
        const membership = await database.pool.query<{ ended_at: Date }>(
          'SELECT ended_at FROM memberships WHERE id = $1',
          [seed.membershipId],
        );
        assert.deepEqual(membership.rows[0]?.ended_at, ARCHIVED_AT);

        const events = await database.pool.query<{ event_type: string }>(
          `SELECT event_type FROM outbox_events
           WHERE home_id = $1 ORDER BY event_type`,
          [seed.homeId],
        );
        assert.deepEqual(
          events.rows.map((row) => row.event_type),
          ['home.archived.v1', 'membership.ended.v1'],
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [seed.homeId, other.homeId],
          userIds: [...seed.userIds, other.userId],
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls invitation updates back when a later archive step fails',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seed = await seedMixedInvitations(
        database.pool,
        'Archive Invitation Rollback Later',
      );
      try {
        await assert.rejects(
          () =>
            createCommand(database.pool, {
              homeArchive: {
                archiveActiveHome() {
                  return Promise.reject(
                    new Error('injected Home writer failure'),
                  );
                },
              },
            })({
              homeId: seed.homeId,
              actor: actor(seed),
            }),
          /injected Home writer failure/,
        );

        for (const pending of seed.pending) {
          assert.deepEqual(
            await loadInvitation(database.pool, pending.id),
            pending,
          );
        }
        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [seed.homeId],
        );
        assert.equal(home.rows[0]?.archived_at, null);
        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [
          seed.membershipId,
        ]);
        assert.equal(membership.rows[0]?.ended_at, null);
        const events = await database.pool.query(
          'SELECT event_id FROM outbox_events WHERE home_id = $1',
          [seed.homeId],
        );
        assert.equal(events.rowCount, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [seed.homeId],
          userIds: seed.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls Home archive back when invitation revocation fails',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seed = await seedMixedInvitations(
        database.pool,
        'Archive Invitation Rollback Revoker',
      );
      const real = createInvitationHomeArchiveCleanup(
        createInvitationRepository(database.pool),
      );
      try {
        await assert.rejects(
          () =>
            createCommand(database.pool, {
              invitationRevoker: {
                lockPendingForHomeArchive: real.lockPendingForHomeArchive,
                revokeLockedPendingForHomeArchive() {
                  return Promise.reject(
                    new Error('injected invitation revoke failure'),
                  );
                },
              },
            })({
              homeId: seed.homeId,
              actor: actor(seed),
            }),
          /injected invitation revoke failure/,
        );

        for (const pending of seed.pending) {
          assert.deepEqual(
            await loadInvitation(database.pool, pending.id),
            pending,
          );
        }
        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [seed.homeId],
        );
        assert.equal(home.rows[0]?.archived_at, null);
        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [
          seed.membershipId,
        ]);
        assert.equal(membership.rows[0]?.ended_at, null);
        const events = await database.pool.query(
          'SELECT event_id FROM outbox_events WHERE home_id = $1',
          [seed.homeId],
        );
        assert.equal(events.rowCount, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [seed.homeId],
          userIds: seed.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'fails the whole archive when a locked pending invitation cannot be updated',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const seed = await seedMixedInvitations(
        database.pool,
        'Archive Invitation Integrity',
      );
      try {
        await assert.rejects(
          () =>
            createCommand(database.pool, {
              invitationRevoker: createInvitationHomeArchiveCleanup({
                lockEffectivePendingForHomeArchive: (tx, input) =>
                  createInvitationRepository(
                    database.pool,
                  ).lockEffectivePendingForHomeArchive(tx, input),
                revokeLocked() {
                  return Promise.resolve(0);
                },
              }),
            })({
              homeId: seed.homeId,
              actor: actor(seed),
            }),
          InvitationPersistenceError,
        );

        const home = await database.pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [seed.homeId],
        );
        assert.equal(home.rows[0]?.archived_at, null);
        for (const pending of seed.pending) {
          assert.equal(
            (await loadInvitation(database.pool, pending.id)).revoked_at,
            null,
          );
        }
      } finally {
        await cleanup(database.pool, {
          homeIds: [seed.homeId],
          userIds: seed.userIds,
        });
        await database.close();
      }
    },
  );

  void it(
    'revokes a create-first invitation after archive waits for the Home lock',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(resolveSafeDedicatedTestDatabaseUrl()),
      );
      const home = await insertHome(database.pool, 'Create Wins Archive Waits');
      const archiveReachedLock = deferred();
      const archiveMayLock = deferred();
      let capturedArchivedAt: Date | undefined;
      const create = createCreateInvitationFromPool(database.pool);

      try {
        const archiveRun = createCommand(database.pool, {
          lockHomeStructure: async (tx, input) => {
            archiveReachedLock.resolve();
            await archiveMayLock.promise;
            return lockHomeStructure(tx, input);
          },
          clock: {
            now() {
              const archivedAt = systemClock.now();
              capturedArchivedAt = archivedAt;
              return archivedAt;
            },
          },
        })({
          homeId: home.homeId,
          actor: actor(home),
        });

        await archiveReachedLock.promise;

        const created = await create({
          actor: actor(home),
          homeId: home.homeId,
          email: `create-wins-${home.homeId}@example.com`,
        });
        const committed = await loadInvitation(
          database.pool,
          created.invitation.id,
        );
        assert.equal(committed.revoked_at, null);
        assert.equal(committed.accepted_at, null);
        assert.equal(capturedArchivedAt === undefined, true);

        archiveMayLock.resolve();
        await archiveRun;

        const archivedAt = capturedArchivedAt;
        if (!(archivedAt instanceof Date)) {
          assert.fail('archive timestamp was sampled before the Home lock');
        }
        const invitation = await loadInvitation(
          database.pool,
          created.invitation.id,
        );
        assert.equal(invitation.accepted_at, null);
        assert.equal(invitation.accepted_membership_id, null);
        assert.ok(invitation.revoked_at instanceof Date);
        assert.equal(invitation.revocation_cause, 'HOME_ARCHIVED');
        assert.equal(archivedAt >= invitation.created_at, true);
        assert.deepEqual(invitation.revoked_at, archivedAt);

        const archivedHome = await database.pool.query<{
          archived_at: Date | null;
        }>('SELECT archived_at FROM homes WHERE id = $1', [home.homeId]);
        assert.deepEqual(archivedHome.rows[0]?.archived_at, archivedAt);

        const membership = await database.pool.query<{
          ended_at: Date | null;
        }>('SELECT ended_at FROM memberships WHERE id = $1', [
          home.membershipId,
        ]);
        assert.deepEqual(membership.rows[0]?.ended_at, archivedAt);
        assert.deepEqual(invitation.revoked_at, membership.rows[0]?.ended_at);
        assert.deepEqual(
          invitation.revoked_at,
          archivedHome.rows[0]?.archived_at,
        );

        const events = await database.pool.query<{ event_type: string }>(
          `SELECT event_type FROM outbox_events
           WHERE home_id = $1 ORDER BY event_type`,
          [home.homeId],
        );
        assert.deepEqual(
          events.rows.map((row) => row.event_type),
          ['home.archived.v1', 'membership.ended.v1'],
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [home.homeId],
          userIds: [home.userId],
        });
        await database.close();
      }
    },
  );
});
