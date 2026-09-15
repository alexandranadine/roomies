import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createActivityRepository } from '../../domains/activity/repository.js';
import { createMaintenanceRepository } from '../../domains/maintenance/repository.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
} from '../../domains/invitations/secret.js';
import {
  createNotificationRepository,
  type NewNotification,
} from '../../domains/notifications/repository.js';
import { createSupplyRepository } from '../../domains/supplies/repository.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { AppConfig } from '../../platform/config/types.js';
import { createUuidV7 } from '../../platform/ids/uuid-v7.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';

export const LIFECYCLE_AT = new Date('2026-09-15T18:00:00.000Z');
export const CREATED_AT = new Date('2026-09-01T12:00:00.000Z');
export const ENDED_AT = new Date('2026-09-10T12:00:00.000Z');
export const CLAIMED_AT = new Date('2026-09-02T12:00:00.000Z');

export function testConfig(databaseUrl: string): AppConfig {
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

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 15);
    });
  }
  throw new Error('timed out waiting for lock wait');
}

export async function isWaitingForLock(
  pool: Pool,
  pid: number,
): Promise<boolean> {
  const result = await pool.query<{ wait_event_type: string | null }>(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  return result.rows[0]?.wait_event_type === 'Lock';
}

export async function backendPid(tx: {
  query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}): Promise<number> {
  const result = await tx.query<{ pid: number | string }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('backend pid was missing');
  }
  return Number(row.pid);
}

export async function insertPlainUser(pool: Pool, id: string): Promise<void> {
  await pool.query('INSERT INTO users (id, updated_at) VALUES ($1, NOW())', [
    id,
  ]);
}

export async function provisionCanonicalUser(
  pool: Pool,
  email: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_identities (name, email, email_verified)
     VALUES ('Account lifecycle', $1, true)
     RETURNING id::text AS id`,
    [email],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('provisioned auth identity id was missing');
  }
  return id;
}

export async function insertAuthAccount(
  pool: Pool,
  userId: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_accounts (account_id, provider_id, user_id, password)
     VALUES ($1, 'credential', $2::uuid, 'lifecycle-hash')
     RETURNING id::text AS id`,
    [userId, userId],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('auth account id was missing');
  }
  return id;
}

export async function insertAuthSession(
  pool: Pool,
  userId: string,
  token: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (expires_at, token, ip_address, user_agent, user_id)
     VALUES (NOW() + INTERVAL '1 hour', $1, '127.0.0.1', 'lifecycle-test', $2::uuid)
     RETURNING id::text AS id`,
    [token, userId],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('auth session id was missing');
  }
  return id;
}

export async function insertVerification(
  pool: Pool,
  input: { identifier: string; value: string },
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO auth_verifications (identifier, value, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')
     RETURNING id::text AS id`,
    [input.identifier, input.value],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new Error('auth verification id was missing');
  }
  return id;
}

export async function insertHome(
  pool: Pool,
  id: string,
  name: string,
  archivedAt: Date | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO homes (id, name, timezone, archived_at, updated_at)
     VALUES ($1, $2, 'UTC', $3, NOW())`,
    [id, name, archivedAt],
  );
}

export async function insertMembership(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    userId: string;
    role: 'ADMIN' | 'ROOMMATE';
    endedAt?: Date | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (
       id, home_id, user_id, role, joined_at, ended_at, ended_by_membership_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.homeId,
      input.userId,
      input.role,
      CREATED_AT,
      input.endedAt ?? null,
      input.endedAt ? input.id : null,
    ],
  );
}

export async function insertInvitation(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    invitedEmail: string;
    createdByMembershipId: string;
    acceptedAt?: Date | null;
    acceptedMembershipId?: string | null;
    revokedAt?: Date | null;
    revocationCause?: string | null;
    expiresAt?: Date;
    createdAt?: Date;
  },
): Promise<void> {
  const secret = generateInvitationSecret();
  await pool.query(
    `INSERT INTO invitations (
       id, home_id, invited_email, token_hash, created_by_membership_id,
       created_at, expires_at, accepted_at, accepted_membership_id,
       revoked_at, revocation_cause
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.id,
      input.homeId,
      input.invitedEmail,
      Buffer.from(hashInvitationSecretBytes(secret.bytes)),
      input.createdByMembershipId,
      input.createdAt ?? CREATED_AT,
      input.expiresAt ?? new Date('2026-12-01T00:00:00.000Z'),
      input.acceptedAt ?? null,
      input.acceptedMembershipId ?? null,
      input.revokedAt ?? null,
      input.revocationCause ?? null,
    ],
  );
}

export async function insertManualTask(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    title: string;
    assignedMembershipId: string | null;
    status?: 'OPEN' | 'COMPLETED';
    completedByMembershipId?: string | null;
  },
): Promise<void> {
  const status = input.status ?? 'OPEN';
  await pool.query(
    `INSERT INTO task_instances (
       id, home_id, source, status, title, scheduled_for,
       assigned_membership_id, task_definition_id, completed_at,
       completed_by_membership_id, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'MANUAL', $3, $4, NULL, $5::uuid, NULL, $6::timestamptz,
       $7::uuid, $8::timestamptz, $8::timestamptz
     )`,
    [
      input.id,
      input.homeId,
      status,
      input.title,
      input.assignedMembershipId,
      status === 'COMPLETED' ? CREATED_AT : null,
      status === 'COMPLETED' ? (input.completedByMembershipId ?? null) : null,
      CREATED_AT,
    ],
  );
}

export async function insertSupplyWithClaim(
  pool: Pool,
  input: {
    entryId: string;
    claimId: string;
    homeId: string;
    createdByMembershipId: string;
    claimantMembershipId: string;
  },
): Promise<void> {
  const supplies = createSupplyRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await supplies.insertSupplyEntry(tx, {
      id: input.entryId,
      homeId: input.homeId,
      title: 'Paper towels',
      status: 'OPEN',
      createdByMembershipId: input.createdByMembershipId,
      obtainedAt: null,
      obtainedByMembershipId: null,
      canceledAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    await supplies.insertSupplyClaim(tx, {
      id: input.claimId,
      homeId: input.homeId,
      supplyEntryId: input.entryId,
      claimantMembershipId: input.claimantMembershipId,
      claimedAt: CLAIMED_AT,
      releasedAt: null,
      releaseReason: null,
      createdAt: CLAIMED_AT,
      updatedAt: CLAIMED_AT,
    });
  });
}

export async function insertMaintenanceEntry(
  pool: Pool,
  input: {
    id: string;
    homeId: string;
    createdByMembershipId: string;
    visibility: 'HOUSEHOLD' | 'PRIVATE';
    title: string;
    audienceMembershipIds?: readonly string[];
    resolvedByMembershipId?: string;
    status?: 'OPEN' | 'RESOLVED';
  },
): Promise<void> {
  const maintenance = createMaintenanceRepository(pool);
  const resolved =
    input.status === 'RESOLVED' || input.resolvedByMembershipId !== undefined;
  await runInReadCommittedTransaction(pool, async (tx) => {
    await maintenance.insertEntryWithAudience(tx, {
      entry: {
        id: input.id,
        homeId: input.homeId,
        createdByMembershipId: input.createdByMembershipId,
        visibility: input.visibility,
        title: input.title,
        details: null,
        status: resolved ? 'RESOLVED' : 'OPEN',
        resolvedByMembershipId: input.resolvedByMembershipId ?? null,
        resolvedAt: resolved ? ENDED_AT : null,
        createdAt: CREATED_AT,
        updatedAt: resolved ? ENDED_AT : CREATED_AT,
      },
      audienceMembershipIds: input.audienceMembershipIds ?? [],
    });
  });
}

export async function insertHomeVisibleActivity(
  pool: Pool,
  input: {
    id?: string;
    homeId: string;
    sourceEntityType: 'TASK' | 'SUPPLY' | 'MEMBERSHIP' | 'MAINTENANCE';
    sourceEntityId: string;
    actorMembershipId: string;
    eventType: string;
  },
): Promise<string> {
  const activity = createActivityRepository(pool);
  const id = input.id ?? createUuidV7();
  await runInReadCommittedTransaction(pool, async (tx) => {
    await activity.insertHomeVisibleActivity(tx, {
      id,
      homeId: input.homeId,
      sourceOutboxEventId: createUuidV7(),
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      eventType: input.eventType,
      actorMembershipId: input.actorMembershipId,
      occurredAt: CREATED_AT,
      createdAt: CREATED_AT,
    });
  });
  return id;
}

export async function insertMaintenanceActivity(
  pool: Pool,
  input: {
    homeId: string;
    sourceEntityId: string;
    visibility: 'HOUSEHOLD' | 'PRIVATE';
    recipientMembershipIds?: readonly string[];
    actorMembershipId: string;
  },
): Promise<string> {
  const activity = createActivityRepository(pool);
  const id = createUuidV7();
  await runInReadCommittedTransaction(pool, async (tx) => {
    const row = {
      id,
      homeId: input.homeId,
      sourceOutboxEventId: createUuidV7(),
      sourceEntityType: 'MAINTENANCE' as const,
      sourceEntityId: input.sourceEntityId,
      eventType: 'maintenance.created.v1',
      actorMembershipId: input.actorMembershipId,
      occurredAt: CREATED_AT,
      createdAt: CREATED_AT,
    };
    if (input.visibility === 'HOUSEHOLD') {
      await activity.insertHomeVisibleActivity(tx, row);
      return;
    }
    await activity.insertSourceAuthorizedActivity(
      tx,
      row,
      input.recipientMembershipIds ?? [],
    );
  });
  return id;
}

export async function insertNotificationRow(
  pool: Pool,
  input: NewNotification,
): Promise<void> {
  const notifications = createNotificationRepository(pool);
  await runInReadCommittedTransaction(pool, async (tx) => {
    await notifications.insertNotification(tx, input);
  });
}

export function recipientNotification(input: {
  homeId: string;
  recipientMembershipId: string;
  sourceEntityType?: NewNotification['sourceEntityType'];
  sourceEntityId?: string;
  actorMembershipId?: string | null;
  kind?: NewNotification['kind'];
}): NewNotification {
  return Object.freeze({
    id: createUuidV7(),
    homeId: input.homeId,
    recipientMembershipId: input.recipientMembershipId,
    sourceOutboxEventId: createUuidV7(),
    kind: input.kind ?? 'ASSIGNED_TASK_COMPLETED',
    sourceEntityType: input.sourceEntityType ?? 'TASK',
    sourceEntityId: input.sourceEntityId ?? createUuidV7(),
    actorMembershipId: input.actorMembershipId ?? null,
    occurredAt: CREATED_AT,
    createdAt: CREATED_AT,
    readAt: null,
  });
}

export async function cleanupLifecycle(
  pool: Pool,
  input: { homeIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.homeIds.length > 0) {
    await pool.query(
      'DELETE FROM notifications WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM activity_recipients WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query('DELETE FROM activities WHERE home_id = ANY($1::uuid[])', [
      input.homeIds,
    ]);
    await pool.query(
      'DELETE FROM maintenance_audiences WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM maintenance_entries WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM supply_claims WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM supply_entries WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM task_instances WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM task_definitions WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    await pool.query(
      'DELETE FROM invitations WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
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
    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM memberships WHERE home_id = ANY($1::uuid[])',
      [input.homeIds],
    );
    for (const row of remaining.rows) {
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
  }
  if (input.userIds.length > 0) {
    await pool.query(
      'DELETE FROM auth_verifications WHERE value = ANY($1::text[])',
      [input.userIds],
    );
    await pool.query('DELETE FROM auth_identities WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      input.userIds,
    ]);
  }
}

export type LifecycleSnapshot = Readonly<{
  homeArchived: readonly (Date | null)[];
  memberships: readonly {
    id: string;
    endedAt: Date | null;
  }[];
  openTaskAssignments: readonly (string | null)[];
  activeClaims: number;
  recipientNotifications: number;
  maintenanceEntries: number;
  maintenanceAudiences: number;
  activities: number;
  activityRecipients: number;
  invitations: number;
  userDeletedAt: Date | null;
  identities: number;
  accounts: number;
  sessions: number;
  verifications: number;
  outboxTypes: readonly string[];
}>;

export async function snapshotLifecycle(
  pool: Pool,
  input: {
    userId: string;
    homeIds: string[];
    membershipIds: string[];
    email?: string;
  },
): Promise<LifecycleSnapshot> {
  const homes = await pool.query<{ archived_at: Date | null }>(
    `SELECT archived_at FROM homes WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [input.homeIds],
  );
  const memberships = await pool.query<{ id: string; ended_at: Date | null }>(
    `SELECT id, ended_at FROM memberships
     WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [input.membershipIds],
  );
  const tasks = await pool.query<{ assigned_membership_id: string | null }>(
    `SELECT assigned_membership_id FROM task_instances
     WHERE home_id = ANY($1::uuid[]) AND status = 'OPEN' ORDER BY id`,
    [input.homeIds],
  );
  const claims = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM supply_claims
     WHERE home_id = ANY($1::uuid[]) AND released_at IS NULL`,
    [input.homeIds],
  );
  const notifications = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notifications
     WHERE recipient_membership_id = ANY($1::uuid[])`,
    [input.membershipIds],
  );
  const entries = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM maintenance_entries
     WHERE home_id = ANY($1::uuid[])`,
    [input.homeIds],
  );
  const audiences = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM maintenance_audiences
     WHERE home_id = ANY($1::uuid[])`,
    [input.homeIds],
  );
  const activities = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM activities
     WHERE home_id = ANY($1::uuid[])`,
    [input.homeIds],
  );
  const recipients = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM activity_recipients
     WHERE home_id = ANY($1::uuid[])`,
    [input.homeIds],
  );
  const invitations = await pool.query<{ count: string }>(
    input.email === undefined
      ? {
          text: `SELECT count(*)::text AS count FROM invitations
                 WHERE home_id = ANY($1::uuid[])`,
          values: [input.homeIds],
        }
      : {
          text: `SELECT count(*)::text AS count FROM invitations
                 WHERE invited_email = $1`,
          values: [input.email],
        },
  );
  const user = await pool.query<{ deleted_at: Date | null }>(
    'SELECT deleted_at FROM users WHERE id = $1',
    [input.userId],
  );
  const identities = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM auth_identities WHERE id = $1::uuid',
    [input.userId],
  );
  const accounts = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM auth_accounts WHERE user_id = $1::uuid',
    [input.userId],
  );
  const sessions = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM auth_sessions WHERE user_id = $1::uuid',
    [input.userId],
  );
  const verifications = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM auth_verifications
     WHERE value = $1::text OR identifier = $2::text`,
    [input.userId, input.email ?? ''],
  );
  const outbox = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM outbox_events
     WHERE home_id = ANY($1::uuid[]) ORDER BY created_at, event_id`,
    [input.homeIds],
  );

  return Object.freeze({
    homeArchived: Object.freeze(homes.rows.map((row) => row.archived_at)),
    memberships: Object.freeze(
      memberships.rows.map((row) =>
        Object.freeze({ id: row.id, endedAt: row.ended_at }),
      ),
    ),
    openTaskAssignments: Object.freeze(
      tasks.rows.map((row) => row.assigned_membership_id),
    ),
    activeClaims: Number(claims.rows[0]?.count ?? '0'),
    recipientNotifications: Number(notifications.rows[0]?.count ?? '0'),
    maintenanceEntries: Number(entries.rows[0]?.count ?? '0'),
    maintenanceAudiences: Number(audiences.rows[0]?.count ?? '0'),
    activities: Number(activities.rows[0]?.count ?? '0'),
    activityRecipients: Number(recipients.rows[0]?.count ?? '0'),
    invitations: Number(invitations.rows[0]?.count ?? '0'),
    userDeletedAt: user.rows[0]?.deleted_at ?? null,
    identities: Number(identities.rows[0]?.count ?? '0'),
    accounts: Number(accounts.rows[0]?.count ?? '0'),
    sessions: Number(sessions.rows[0]?.count ?? '0'),
    verifications: Number(verifications.rows[0]?.count ?? '0'),
    outboxTypes: Object.freeze(outbox.rows.map((row) => row.event_type)),
  });
}

export function uniqueLifecycleEmail(prefix: string): string {
  return normalizeEmail(`${prefix}-${randomUUID()}@roomies.test`);
}

export async function releaseStaleTestBackends(pool: Pool): Promise<void> {
  await pool.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state = 'idle in transaction'
  `);
}
