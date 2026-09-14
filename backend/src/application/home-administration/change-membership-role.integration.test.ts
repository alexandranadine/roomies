import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { LastAdminRequiredError } from '../../domains/memberships/errors.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { createMembershipRoleTransitionWriter } from '../../domains/memberships/insert-membership-role-transition.js';
import { createMembershipRoleWriter } from '../../domains/memberships/update-active-membership-role.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createOutboxWriter } from '../../platform/events/outbox-writer.js';
import { createDatabasePool } from '../../platform/persistence/pool.js';
import {
  parseDatabaseUrl,
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createChangeMembershipRole } from './change-membership-role.js';

const skipWithoutDatabase = skipUnlessDedicatedTestDatabase();

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

function dedicatedTestDatabaseUrl(): string {
  return resolveSafeDedicatedTestDatabaseUrl();
}

function actor(input: {
  userId: string;
  membershipId: string;
  homeId: string;
  role: ActiveHomeActor['role'];
}): ActiveHomeActor {
  return { ...input };
}

async function insertUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

async function insertHome(
  pool: Pool,
  input: { id: string; name: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [input.id, input.name],
  );
}

async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role: 'ROOMMATE' | 'ADMIN';
    ended?: boolean;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (id, home_id, user_id, role, ended_at, ended_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      input.ended === true ? new Date() : null,
      input.ended === true ? input.id : null,
    ],
  );
}

async function cleanup(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  await pool.query(
    'DELETE FROM outbox_events WHERE home_id = ANY($1::uuid[])',
    [input.homeIds],
  );
  await pool.query(
    'DELETE FROM membership_role_transitions WHERE home_id = ANY($1::uuid[])',
    [input.homeIds],
  );
  await pool.query(
    `UPDATE memberships
     SET ended_by_membership_id = id
     WHERE home_id = ANY($1::uuid[]) AND ended_at IS NOT NULL`,
    [input.homeIds],
  );
  await pool.query(
    `DELETE FROM memberships
     WHERE home_id = ANY($1::uuid[]) AND ended_at IS NULL`,
    [input.homeIds],
  );
  const remainingMemberships = await pool.query<{ id: string }>(
    'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
    [input.homeIds],
  );
  for (const row of remainingMemberships.rows) {
    await pool.query(
      `UPDATE memberships
       SET ended_at = NULL, ended_by_membership_id = NULL
       WHERE id = $1`,
      [row.id],
    );
    await pool.query('DELETE FROM memberships WHERE id = $1', [row.id]);
  }
  await pool.query('DELETE FROM homes WHERE id = ANY($1::uuid[])', [
    input.homeIds,
  ]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    input.userIds,
  ]);
}

function createCommand(
  pool: Pool,
  overrides: Partial<Parameters<typeof createChangeMembershipRole>[0]> = {},
) {
  return createChangeMembershipRole({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    outbox: createOutboxWriter(),
    clock: { now: () => new Date('2026-03-15T12:34:56.789Z') },
    ids: {
      next() {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        const hex = [...bytes]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    },
    roleWriter: createMembershipRoleWriter(),
    roleTransitions: createMembershipRoleTransitionWriter(),
    ...overrides,
  });
}

void describe('changeMembershipRole PostgreSQL', () => {
  void it(
    'uses only a dedicated safe TEST_DATABASE_URL',
    { skip: skipWithoutDatabase },
    () => {
      const url = dedicatedTestDatabaseUrl();
      const parsed = parseDatabaseUrl(url);
      assert.notEqual(parsed.database.toLowerCase(), 'roomies');
      assert.match(parsed.database, /(?:^|_)(?:test|ci)$/i);
    },
  );

  void it(
    'commits a role update and membership.role_changed.v1 together',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Promote Home' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const change = createCommand(database.pool);
        const result = await change({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          membershipId: membershipB,
          role: 'ADMIN',
        });

        assert.deepEqual(result, {
          changed: true,
          previousRole: 'ROOMMATE',
          newRole: 'ADMIN',
        });

        const roles = await database.pool.query<{ id: string; role: string }>(
          'SELECT id, role FROM memberships WHERE home_id = $1 ORDER BY id',
          [homeId],
        );
        assert.deepEqual(
          new Set(roles.rows.map((row) => `${row.id}:${row.role}`)),
          new Set([`${membershipA}:ADMIN`, `${membershipB}:ADMIN`]),
        );

        const events = await database.pool.query<{
          event_type: string;
          occurred_at: Date;
          payload: {
            membershipId: string;
            roleTransitionId: string;
          };
        }>(
          `SELECT event_type, occurred_at, payload
           FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.role_changed.v1'`,
          [homeId],
        );
        assert.equal(events.rows.length, 1);
        assert.deepEqual(Object.keys(events.rows[0]?.payload ?? {}).sort(), [
          'membershipId',
          'roleTransitionId',
        ]);
        assert.equal(events.rows[0]?.payload.membershipId, membershipB);
        assert.equal('previousRole' in (events.rows[0]?.payload ?? {}), false);
        assert.equal('newRole' in (events.rows[0]?.payload ?? {}), false);

        const transitions = await database.pool.query<{
          id: string;
          membership_id: string;
          actor_membership_id: string;
          changed_at: Date;
          created_at: Date;
        }>(
          `SELECT id, membership_id, actor_membership_id, changed_at, created_at
           FROM membership_role_transitions
           WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(transitions.rows.length, 1);
        assert.equal(transitions.rows[0]?.membership_id, membershipB);
        assert.equal(transitions.rows[0]?.actor_membership_id, membershipA);
        assert.equal(
          events.rows[0]?.payload.roleTransitionId,
          transitions.rows[0]?.id,
        );
        assert.equal(
          events.rows[0]?.occurred_at.getTime(),
          transitions.rows[0]?.changed_at.getTime(),
        );
        assert.notEqual(
          transitions.rows[0]?.actor_membership_id,
          transitions.rows[0]?.membership_id,
        );
        assert.equal(
          transitions.rows[0]?.changed_at.getTime(),
          transitions.rows[0]?.created_at.getTime(),
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'rolls back the Membership role when outbox append fails',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Rollback Home' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const change = createCommand(database.pool, {
          outbox: {
            append() {
              return Promise.reject(new Error('injected outbox failure'));
            },
          },
        });

        await assert.rejects(
          () =>
            change({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              membershipId: membershipB,
              role: 'ADMIN',
            }),
          /injected outbox failure/,
        );

        const roles = await database.pool.query<{ role: string }>(
          'SELECT role FROM memberships WHERE id = $1',
          [membershipB],
        );
        assert.equal(roles.rows[0]?.role, 'ROOMMATE');

        const events = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.role_changed.v1'`,
          [homeId],
        );
        assert.equal(events.rows.length, 0);
        const transitions = await database.pool.query<{ id: string }>(
          'SELECT id FROM membership_role_transitions WHERE home_id = $1',
          [homeId],
        );
        assert.equal(transitions.rows.length, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'same-role leaves Membership and outbox unchanged',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const updates: unknown[] = [];

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Noop Home' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const inner = createMembershipRoleWriter();
        const change = createCommand(database.pool, {
          roleWriter: {
            updateActiveRole(tx, input) {
              updates.push(input);
              return inner.updateActiveRole(tx, input);
            },
          },
        });

        const result = await change({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          membershipId: membershipB,
          role: 'ROOMMATE',
        });

        assert.deepEqual(result, { changed: false });
        assert.deepEqual(updates, []);

        const events = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.role_changed.v1'`,
          [homeId],
        );
        assert.equal(events.rows.length, 0);
        const transitions = await database.pool.query<{ id: string }>(
          'SELECT id FROM membership_role_transitions WHERE home_id = $1',
          [homeId],
        );
        assert.equal(transitions.rows.length, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'structural last-Admin conflict mutates nothing and writes no event',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Last Admin Home',
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const change = createCommand(database.pool);
        await assert.rejects(
          () =>
            change({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              membershipId: membershipA,
              role: 'ROOMMATE',
            }),
          LastAdminRequiredError,
        );

        const roles = await database.pool.query<{ id: string; role: string }>(
          'SELECT id, role FROM memberships WHERE home_id = $1',
          [homeId],
        );
        assert.deepEqual(
          new Set(roles.rows.map((row) => `${row.id}:${row.role}`)),
          new Set([`${membershipA}:ADMIN`, `${membershipB}:ROOMMATE`]),
        );
        const events = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(events.rows.length, 0);
        const transitions = await database.pool.query<{ id: string }>(
          'SELECT id FROM membership_role_transitions WHERE home_id = $1',
          [homeId],
        );
        assert.equal(transitions.rows.length, 0);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'serializes reciprocal demotions to one 204, one 403, and one Admin',
    { skip: skipWithoutDatabase, timeout: 20_000 },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Reciprocal Home',
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ADMIN',
        });

        const change = createCommand(database.pool);
        const results = await Promise.allSettled([
          change({
            actor: actor({
              userId: userA,
              membershipId: membershipA,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipB,
            role: 'ROOMMATE',
          }),
          change({
            actor: actor({
              userId: userB,
              membershipId: membershipB,
              homeId,
              role: 'ADMIN',
            }),
            homeId,
            membershipId: membershipA,
            role: 'ROOMMATE',
          }),
        ]);

        const fulfilled = results.filter(
          (result) => result.status === 'fulfilled',
        );
        const rejected = results.filter(
          (result) => result.status === 'rejected',
        );
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(
          fulfilled[0]?.status === 'fulfilled' && fulfilled[0].value.changed,
          true,
        );
        assert.ok(
          rejected[0]?.status === 'rejected' &&
            rejected[0].reason instanceof ForbiddenError,
        );

        const roles = await database.pool.query<{ role: string }>(
          'SELECT role FROM memberships WHERE home_id = $1',
          [homeId],
        );
        const adminCount = roles.rows.filter(
          (row) => row.role === 'ADMIN',
        ).length;
        assert.equal(adminCount, 1);
        assert.equal(roles.rows.length, 2);

        const events = await database.pool.query<{ event_id: string }>(
          `SELECT event_id FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.role_changed.v1'`,
          [homeId],
        );
        assert.equal(events.rows.length, 1);
        const transitions = await database.pool.query<{ id: string }>(
          'SELECT id FROM membership_role_transitions WHERE home_id = $1',
          [homeId],
        );
        assert.equal(transitions.rows.length, 1);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'records two successive distinct transitions including the same frozen timestamp',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipB = randomUUID();
      const occurredAt = new Date('2026-03-15T12:34:56.789Z');

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Successive Transitions',
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipB,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const change = createCommand(database.pool, {
          clock: { now: () => occurredAt },
        });
        const first = await change({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          membershipId: membershipB,
          role: 'ADMIN',
        });
        const second = await change({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          membershipId: membershipB,
          role: 'ROOMMATE',
        });
        assert.equal(first.changed, true);
        assert.equal(second.changed, true);

        const transitions = await database.pool.query<{
          id: string;
          membership_id: string;
          actor_membership_id: string;
          changed_at: Date;
        }>(
          `SELECT id, membership_id, actor_membership_id, changed_at
           FROM membership_role_transitions
           WHERE home_id = $1
           ORDER BY id`,
          [homeId],
        );
        assert.equal(transitions.rows.length, 2);
        assert.notEqual(transitions.rows[0]?.id, transitions.rows[1]?.id);
        assert.equal(
          transitions.rows[0]?.changed_at.getTime(),
          occurredAt.getTime(),
        );
        assert.equal(
          transitions.rows[1]?.changed_at.getTime(),
          occurredAt.getTime(),
        );
        assert.deepEqual(
          new Set(transitions.rows.map((row) => row.membership_id)),
          new Set([membershipB]),
        );
        assert.deepEqual(
          new Set(transitions.rows.map((row) => row.actor_membership_id)),
          new Set([membershipA]),
        );
        const earlierTransition = transitions.rows[0];
        assert.ok(earlierTransition);
        const afterLaterMutation = await database.pool.query<{
          id: string;
          membership_id: string;
          actor_membership_id: string;
          changed_at: Date;
        }>(
          `SELECT id, membership_id, actor_membership_id, changed_at
           FROM membership_role_transitions
           WHERE id = $1`,
          [earlierTransition.id],
        );
        assert.equal(afterLaterMutation.rows[0]?.id, earlierTransition.id);
        assert.equal(
          afterLaterMutation.rows[0]?.membership_id,
          earlierTransition.membership_id,
        );
        assert.equal(
          afterLaterMutation.rows[0]?.actor_membership_id,
          earlierTransition.actor_membership_id,
        );
        assert.equal(
          afterLaterMutation.rows[0]?.changed_at.getTime(),
          earlierTransition.changed_at.getTime(),
        );

        const events = await database.pool.query<{
          payload: { membershipId: string; roleTransitionId: string };
        }>(
          `SELECT payload FROM outbox_events
           WHERE home_id = $1 AND event_type = 'membership.role_changed.v1'
           ORDER BY event_id`,
          [homeId],
        );
        assert.equal(events.rows.length, 2);
        const eventTransitionIds = events.rows.map(
          (row) => row.payload.roleTransitionId,
        );
        assert.deepEqual(
          new Set(eventTransitionIds),
          new Set(transitions.rows.map((row) => row.id)),
        );
        assert.notEqual(eventTransitionIds[0], eventTransitionIds[1]);
        assert.ok(
          events.rows.every((row) => row.payload.membershipId === membershipB),
        );
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'conceals an ended OLD tenure id and leaves the NEW tenure unchanged',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipOld = randomUUID();
      const membershipNew = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, { id: homeId, name: 'Rejoin Home' });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipOld,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
          ended: true,
        });
        await insertMembership(database.pool, {
          id: membershipNew,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const change = createCommand(database.pool);
        await assert.rejects(
          () =>
            change({
              actor: actor({
                userId: userA,
                membershipId: membershipA,
                homeId,
                role: 'ADMIN',
              }),
              homeId,
              membershipId: membershipOld,
              role: 'ADMIN',
            }),
          ConcealedNotFoundError,
        );

        const current = await database.pool.query<{ role: string }>(
          'SELECT role FROM memberships WHERE id = $1',
          [membershipNew],
        );
        assert.equal(current.rows[0]?.role, 'ROOMMATE');
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );

  void it(
    'keeps earlier role transition history after the subject ends and rejoins',
    { skip: skipWithoutDatabase },
    async () => {
      const database = createDatabasePool(
        testConfig(dedicatedTestDatabaseUrl()),
      );
      const userA = randomUUID();
      const userB = randomUUID();
      const homeId = randomUUID();
      const membershipA = randomUUID();
      const membershipOld = randomUUID();
      const membershipNew = randomUUID();

      try {
        await insertUser(database.pool, userA);
        await insertUser(database.pool, userB);
        await insertHome(database.pool, {
          id: homeId,
          name: 'Transition Rejoin',
        });
        await insertMembership(database.pool, {
          id: membershipA,
          homeId,
          userId: userA,
          role: 'ADMIN',
        });
        await insertMembership(database.pool, {
          id: membershipOld,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const change = createCommand(database.pool);
        await change({
          actor: actor({
            userId: userA,
            membershipId: membershipA,
            homeId,
            role: 'ADMIN',
          }),
          homeId,
          membershipId: membershipOld,
          role: 'ADMIN',
        });

        const beforeEnd = await database.pool.query<{
          id: string;
          membership_id: string;
          actor_membership_id: string;
          changed_at: Date;
        }>(
          `SELECT id, membership_id, actor_membership_id, changed_at
           FROM membership_role_transitions
           WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(beforeEnd.rows.length, 1);
        const historical = beforeEnd.rows[0];
        assert.ok(historical);

        await database.pool.query(
          `UPDATE memberships
           SET ended_at = NOW(), ended_by_membership_id = $1
           WHERE id = $1`,
          [membershipOld],
        );
        await insertMembership(database.pool, {
          id: membershipNew,
          homeId,
          userId: userB,
          role: 'ROOMMATE',
        });

        const afterRejoin = await database.pool.query<{
          id: string;
          membership_id: string;
          actor_membership_id: string;
          changed_at: Date;
        }>(
          `SELECT id, membership_id, actor_membership_id, changed_at
           FROM membership_role_transitions
           WHERE home_id = $1`,
          [homeId],
        );
        assert.equal(afterRejoin.rows.length, 1);
        assert.equal(afterRejoin.rows[0]?.id, historical.id);
        assert.equal(afterRejoin.rows[0]?.membership_id, membershipOld);
        assert.equal(afterRejoin.rows[0]?.actor_membership_id, membershipA);
        assert.equal(
          afterRejoin.rows[0]?.changed_at.getTime(),
          historical.changed_at.getTime(),
        );
        assert.notEqual(afterRejoin.rows[0]?.membership_id, membershipNew);
      } finally {
        await cleanup(database.pool, {
          homeIds: [homeId],
          userIds: [userA, userB],
        });
        await database.close();
      }
    },
  );
});
