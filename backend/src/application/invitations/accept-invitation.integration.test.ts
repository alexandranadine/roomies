import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { lockActiveHomeStructureForEntry } from '../../domains/homes/index.js';
import { createInvitationRepository } from '../../domains/invitations/repository.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
  invitationTokenHashesEqual,
} from '../../domains/invitations/secret.js';
import {
  findLatestEndedMembershipTenure,
  insertInvitationMembership,
} from '../../domains/memberships/index.js';
import { findCurrentCanonicalIdentityByUser } from '../../platform/auth/index.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { systemClock } from '../../platform/time/clock.js';
import { createArchiveFinalMemberHomeFromPool } from '../home-administration/archive-final-member-home.js';
import {
  createAcceptInvitation,
  createAcceptInvitationFromPool,
} from './accept-invitation.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

async function seedAcceptance(pool: Pool, suffix: string) {
  const adminId = randomUUID();
  const userId = randomUUID();
  const homeId = randomUUID();
  const adminMembershipId = randomUUID();
  const invitationId = randomUUID();
  const secret = generateInvitationSecret();
  const email = `acceptance-${suffix}@example.com`;
  const createdAt = new Date(Date.now() - 60_000);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO auth_identities (id, name, email, email_verified)
     VALUES ($1, 'Accepting User', $2, true)`,
    [userId, email],
  );
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, now())', [
    adminId,
  ]);
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, 'Acceptance Home', 'UTC', now())`,
    [homeId],
  );
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role)
     VALUES ($1, $2, $3, 'ADMIN')`,
    [adminMembershipId, homeId, adminId],
  );
  await pool.query(
    `INSERT INTO invitations (
       id, home_id, invited_email, token_hash, created_by_membership_id,
       created_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      invitationId,
      homeId,
      email,
      Buffer.from(hashInvitationSecretBytes(secret.bytes)),
      adminMembershipId,
      createdAt,
      expiresAt,
    ],
  );

  return {
    adminId,
    userId,
    homeId,
    adminMembershipId,
    invitationId,
    secret,
    email,
  };
}

async function cleanup(
  pool: Pool,
  seed: Awaited<ReturnType<typeof seedAcceptance>>,
) {
  await pool.query(`DELETE FROM outbox_events WHERE home_id = $1`, [
    seed.homeId,
  ]);
  await pool.query('DELETE FROM invitations WHERE id = $1', [
    seed.invitationId,
  ]);
  await pool.query('DELETE FROM memberships WHERE home_id = $1', [seed.homeId]);
  await pool.query('DELETE FROM homes WHERE id = $1', [seed.homeId]);
  await pool.query('DELETE FROM auth_identities WHERE id = $1', [seed.userId]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    [seed.userId, seed.adminId],
  ]);
}

function createRollbackTestCommand(
  pool: Pool,
  overrides: {
    insertMembership?: typeof insertInvitationMembership;
    acceptLocked?: ReturnType<
      typeof createInvitationRepository
    >['acceptLocked'];
    append?: typeof outboxWriter.append;
  },
) {
  const repository = createInvitationRepository(pool);
  const appendOverride = overrides.append;
  return createAcceptInvitation({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    invitations: {
      findById: repository.findById,
      lockById: repository.lockById,
      acceptLocked: overrides.acceptLocked ?? repository.acceptLocked,
    },
    lockHomeStructure: lockActiveHomeStructureForEntry,
    findCurrentIdentity: findCurrentCanonicalIdentityByUser,
    findLatestEndedTenure: findLatestEndedMembershipTenure,
    insertMembership: overrides.insertMembership ?? insertInvitationMembership,
    outbox: {
      append: (tx, event) =>
        appendOverride === undefined
          ? outboxWriter.append(tx, event)
          : appendOverride(tx, event),
    },
    clock: systemClock,
    ids: systemUuidV7,
    hashesEqual: invitationTokenHashesEqual,
  });
}

void describe('invitation acceptance PostgreSQL concurrency', () => {
  void it(
    'accepts once atomically and persists one new ROOMMATE tenure and event',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 4,
      });
      const seed = await seedAcceptance(pool, randomUUID());
      try {
        const command = createAcceptInvitationFromPool(pool);
        const result = await command({
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        });

        const membership = await pool.query<{
          id: string;
          role: string;
          joined_at: Date;
          ended_at: Date | null;
        }>(
          `SELECT id, role, joined_at, ended_at
           FROM memberships
           WHERE home_id = $1 AND user_id = $2`,
          [seed.homeId, seed.userId],
        );
        assert.equal(membership.rowCount, 1);
        assert.equal(membership.rows[0]?.id, result.membershipId);
        assert.equal(membership.rows[0]?.role, 'ROOMMATE');
        assert.equal(membership.rows[0]?.ended_at, null);

        const accepted = await pool.query<{
          accepted_at: Date;
          accepted_membership_id: string;
        }>(
          `SELECT accepted_at, accepted_membership_id
           FROM invitations WHERE id = $1`,
          [seed.invitationId],
        );
        assert.equal(
          accepted.rows[0]?.accepted_membership_id,
          result.membershipId,
        );
        assert.equal(
          accepted.rows[0]?.accepted_at.getTime(),
          membership.rows[0]?.joined_at.getTime(),
        );

        const events = await pool.query<{
          occurred_at: Date;
          payload: {
            membershipId: string;
            cause: string;
            invitationId: string;
          };
        }>(
          `SELECT occurred_at, payload
           FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.started.v1'`,
          [seed.homeId],
        );
        assert.equal(events.rowCount, 1);
        assert.deepEqual(events.rows[0]?.payload, {
          membershipId: result.membershipId,
          cause: 'INVITATION_ACCEPTED',
          invitationId: seed.invitationId,
        });
        assert.equal(
          events.rows[0]?.occurred_at.getTime(),
          membership.rows[0]?.joined_at.getTime(),
        );
      } finally {
        await cleanup(pool, seed);
        await pool.end();
      }
    },
  );

  void it(
    'serializes repeated concurrent acceptance to one success',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 6,
      });
      const seed = await seedAcceptance(pool, randomUUID());
      try {
        const command = createAcceptInvitationFromPool(pool);
        const input = {
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        };
        const settled = await Promise.allSettled([
          command(input),
          command(input),
        ]);
        assert.equal(
          settled.filter((result) => result.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          settled.filter((result) => result.status === 'rejected').length,
          1,
        );

        const active = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM memberships
           WHERE home_id = $1 AND user_id = $2 AND ended_at IS NULL`,
          [seed.homeId, seed.userId],
        );
        assert.equal(active.rows[0]?.count, '1');
        const events = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.started.v1'`,
          [seed.homeId],
        );
        assert.equal(events.rows[0]?.count, '1');
      } finally {
        await cleanup(pool, seed);
        await pool.end();
      }
    },
  );

  void it(
    'rolls back Membership and invitation state for every transactional write failure',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 4,
      });
      const seed = await seedAcceptance(pool, randomUUID());
      const input = {
        invitationId: seed.invitationId,
        userId: seed.userId,
        secret: seed.secret.encoded,
      };
      const assertPendingWithoutMembership = async () => {
        const state = await pool.query<{
          accepted_at: Date | null;
          accepted_membership_id: string | null;
          membership_count: string;
        }>(
          `SELECT i.accepted_at, i.accepted_membership_id,
                  (SELECT count(*)::text FROM memberships m
                   WHERE m.home_id = i.home_id AND m.user_id = $2) AS membership_count
           FROM invitations i WHERE i.id = $1`,
          [seed.invitationId, seed.userId],
        );
        assert.deepEqual(state.rows[0], {
          accepted_at: null,
          accepted_membership_id: null,
          membership_count: '0',
        });
      };

      try {
        await assert.rejects(
          createRollbackTestCommand(pool, {
            insertMembership: () =>
              Promise.reject(new Error('injected Membership failure')),
          })(input),
        );
        await assertPendingWithoutMembership();

        await assert.rejects(
          createRollbackTestCommand(pool, {
            acceptLocked: () => Promise.resolve(0),
          })(input),
        );
        await assertPendingWithoutMembership();

        await assert.rejects(
          createRollbackTestCommand(pool, {
            append: () => Promise.reject(new Error('injected outbox failure')),
          })(input),
        );
        await assertPendingWithoutMembership();
      } finally {
        await cleanup(pool, seed);
        await pool.end();
      }
    },
  );

  void it(
    'acceptance racing final-member archive has one structurally valid outcome',
    { skip: skipWithoutDatabase, timeout: 60_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 8,
      });
      const homeIds: string[] = [];
      try {
        for (let iteration = 0; iteration < 10; iteration += 1) {
          const seed = await seedAcceptance(
            pool,
            `${randomUUID()}-${iteration}`,
          );
          homeIds.push(seed.homeId);
          const accept = createAcceptInvitationFromPool(pool);
          const archive = createArchiveFinalMemberHomeFromPool(pool);
          const settled = await Promise.allSettled([
            accept({
              invitationId: seed.invitationId,
              userId: seed.userId,
              secret: seed.secret.encoded,
            }),
            archive({
              homeId: seed.homeId,
              actor: {
                userId: seed.adminId,
                membershipId: seed.adminMembershipId,
                homeId: seed.homeId,
                role: 'ADMIN',
              },
            }),
          ]);

          const home = await pool.query<{ archived_at: Date | null }>(
            'SELECT archived_at FROM homes WHERE id = $1',
            [seed.homeId],
          );
          const invitation = await pool.query<{
            accepted_at: Date | null;
            revoked_at: Date | null;
            revocation_cause: string | null;
          }>(
            `SELECT accepted_at, revoked_at, revocation_cause
             FROM invitations WHERE id = $1`,
            [seed.invitationId],
          );
          const joined = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM memberships
             WHERE home_id = $1 AND user_id = $2`,
            [seed.homeId, seed.userId],
          );
          const admin = await pool.query<{ ended_at: Date | null }>(
            'SELECT ended_at FROM memberships WHERE id = $1',
            [seed.adminMembershipId],
          );
          const events = await pool.query<{ event_type: string }>(
            `SELECT event_type FROM outbox_events WHERE home_id = $1`,
            [seed.homeId],
          );
          const eventTypes = events.rows.map((row) => row.event_type);
          const invite = invitation.rows[0];
          assert.ok(invite);
          assert.equal(
            invite.accepted_at !== null && invite.revoked_at !== null,
            false,
          );

          if (home.rows[0]?.archived_at === null) {
            assert.equal(settled[0]?.status, 'fulfilled');
            assert.equal(settled[1]?.status, 'rejected');
            assert.ok(invite.accepted_at instanceof Date);
            assert.equal(invite.revoked_at, null);
            assert.equal(joined.rows[0]?.count, '1');
            assert.equal(admin.rows[0]?.ended_at, null);
            assert.equal(
              eventTypes.filter((type) => type === 'membership.started.v1')
                .length,
              1,
            );
            assert.equal(
              eventTypes.includes('membership.ended.v1') ||
                eventTypes.includes('home.archived.v1'),
              false,
            );
          } else {
            assert.equal(settled[0]?.status, 'rejected');
            assert.equal(settled[1]?.status, 'fulfilled');
            assert.equal(invite.accepted_at, null);
            assert.ok(invite.revoked_at instanceof Date);
            assert.equal(invite.revocation_cause, 'HOME_ARCHIVED');
            assert.equal(joined.rows[0]?.count, '0');
            assert.ok(admin.rows[0]?.ended_at instanceof Date);
            assert.equal(
              eventTypes.filter((type) => type === 'membership.started.v1')
                .length,
              0,
            );
            assert.equal(
              eventTypes.filter((type) => type === 'membership.ended.v1')
                .length,
              1,
            );
            assert.equal(
              eventTypes.filter((type) => type === 'home.archived.v1').length,
              1,
            );
          }
          await cleanup(pool, seed);
        }
      } finally {
        if (homeIds.length > 0) {
          await pool.query(
            'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
            [homeIds],
          );
          await pool.query(
            'DELETE FROM invitations WHERE home_id = ANY($1::uuid[])',
            [homeIds],
          );
        }
        await pool.end();
      }
    },
  );

  void it(
    'multiple acceptance attempts racing archive reach one allowed outcome',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 8,
      });
      const seed = await seedAcceptance(pool, randomUUID());
      try {
        const accept = createAcceptInvitationFromPool(pool);
        const archive = createArchiveFinalMemberHomeFromPool(pool);
        const input = {
          invitationId: seed.invitationId,
          userId: seed.userId,
          secret: seed.secret.encoded,
        };
        const settled = await Promise.allSettled([
          accept(input),
          accept(input),
          archive({
            homeId: seed.homeId,
            actor: {
              userId: seed.adminId,
              membershipId: seed.adminMembershipId,
              homeId: seed.homeId,
              role: 'ADMIN',
            },
          }),
        ]);

        const home = await pool.query<{ archived_at: Date | null }>(
          'SELECT archived_at FROM homes WHERE id = $1',
          [seed.homeId],
        );
        const invitation = await pool.query<{
          accepted_at: Date | null;
          revoked_at: Date | null;
          revocation_cause: string | null;
        }>(
          `SELECT accepted_at, revoked_at, revocation_cause
           FROM invitations WHERE id = $1`,
          [seed.invitationId],
        );
        const joined = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM memberships
           WHERE home_id = $1 AND user_id = $2 AND ended_at IS NULL`,
          [seed.homeId, seed.userId],
        );
        const started = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.started.v1'`,
          [seed.homeId],
        );
        const invite = invitation.rows[0];
        assert.ok(invite);
        const acceptFulfilled = settled
          .slice(0, 2)
          .filter((result) => result.status === 'fulfilled').length;
        assert.ok(acceptFulfilled <= 1);
        assert.equal(
          invite.accepted_at !== null && invite.revoked_at !== null,
          false,
        );

        if (home.rows[0]?.archived_at === null) {
          assert.equal(acceptFulfilled, 1);
          assert.equal(settled[2]?.status, 'rejected');
          assert.ok(invite.accepted_at instanceof Date);
          assert.equal(invite.revoked_at, null);
          assert.equal(joined.rows[0]?.count, '1');
          assert.equal(started.rows[0]?.count, '1');
        } else {
          assert.equal(acceptFulfilled, 0);
          assert.equal(settled[2]?.status, 'fulfilled');
          assert.equal(invite.accepted_at, null);
          assert.equal(invite.revocation_cause, 'HOME_ARCHIVED');
          assert.equal(joined.rows[0]?.count, '0');
          assert.equal(started.rows[0]?.count, '0');
        }
      } finally {
        await cleanup(pool, seed);
        await pool.end();
      }
    },
  );

  void it(
    'acceptance racing a Home-first revocation reaches one terminal state',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 6,
      });
      const seed = await seedAcceptance(pool, randomUUID());
      try {
        const accept = createAcceptInvitationFromPool(pool);
        const repository = createInvitationRepository(pool);
        const revoke = () =>
          runInReadCommittedTransaction(pool, async (tx) => {
            await lockActiveHomeStructureForEntry(tx, {
              homeId: seed.homeId,
            });
            await repository.lockById(tx, {
              homeId: seed.homeId,
              invitationId: seed.invitationId,
            });
            return tx.query(
              `UPDATE invitations
               SET revoked_at = now(), revocation_cause = 'ADMIN_REVOKED'
               WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
              [seed.invitationId],
            );
          });

        await Promise.allSettled([
          accept({
            invitationId: seed.invitationId,
            userId: seed.userId,
            secret: seed.secret.encoded,
          }),
          revoke(),
        ]);

        const invitation = await pool.query<{
          accepted_at: Date | null;
          revoked_at: Date | null;
        }>('SELECT accepted_at, revoked_at FROM invitations WHERE id = $1', [
          seed.invitationId,
        ]);
        const row = invitation.rows[0];
        assert.ok(row);
        assert.notEqual(row.accepted_at === null, row.revoked_at === null);
      } finally {
        await cleanup(pool, seed);
        await pool.end();
      }
    },
  );

  void it(
    'a tenure-ending race cannot use an older invitation to resurrect access',
    { skip: skipWithoutDatabase, timeout: 30_000 },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 6,
      });
      const seed = await seedAcceptance(pool, randomUUID());
      const priorMembershipId = randomUUID();
      try {
        await pool.query(
          `INSERT INTO memberships (id, home_id, user_id, role, joined_at)
           VALUES ($1, $2, $3, 'ROOMMATE', now() - interval '1 day')`,
          [priorMembershipId, seed.homeId, seed.userId],
        );
        const accept = createAcceptInvitationFromPool(pool);
        const endTenure = () =>
          runInReadCommittedTransaction(pool, async (tx) => {
            await lockActiveHomeStructureForEntry(tx, {
              homeId: seed.homeId,
            });
            return tx.query(
              `UPDATE memberships SET ended_at = now()
               WHERE id = $1 AND home_id = $2 AND ended_at IS NULL`,
              [priorMembershipId, seed.homeId],
            );
          });

        const settled = await Promise.allSettled([
          accept({
            invitationId: seed.invitationId,
            userId: seed.userId,
            secret: seed.secret.encoded,
          }),
          endTenure(),
        ]);
        assert.equal(settled[0]?.status, 'rejected');
        assert.equal(settled[1]?.status, 'fulfilled');

        const state = await pool.query<{
          active_count: string;
          accepted_at: Date | null;
        }>(
          `SELECT
             (SELECT count(*)::text FROM memberships
              WHERE home_id = $1 AND user_id = $2 AND ended_at IS NULL) AS active_count,
             (SELECT accepted_at FROM invitations WHERE id = $3) AS accepted_at`,
          [seed.homeId, seed.userId, seed.invitationId],
        );
        assert.deepEqual(state.rows[0], {
          active_count: '0',
          accepted_at: null,
        });
      } finally {
        await cleanup(pool, seed);
        await pool.end();
      }
    },
  );
});
