import type { Pool } from 'pg';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  InvalidNotificationRequestError,
  NotificationPersistenceError,
} from './errors.js';
import {
  isNotificationKind,
  isNotificationKindSourceCompatible,
  isNotificationSourceEntityType,
  type Notification,
  type NotificationKind,
  type NotificationSourceEntityType,
} from './notification.js';
import type {
  EligibleNotification,
  NotificationRepositoryPage,
} from './notification-list-item.js';
import {
  NOTIFICATION_LIST_QUERY_FINGERPRINT,
  assertNotificationListLimit,
  bindNotificationListCursor,
  encodeNotificationListCursor,
} from './cursor.js';

/**
 * Deployed UNIQUE index for (source_outbox_event_id, recipient_membership_id,
 * kind). Idempotency recognizes only this named constraint. Arbitrary unique
 * violations are not duplicates.
 */
export const NOTIFICATION_SOURCE_RECIPIENT_KIND_UNIQUE_CONSTRAINT =
  'notifications_source_recipient_kind_key_15fab2f3';

export const NOTIFICATION_PRUNE_BATCH_SIZE = 100;

export const NOTIFICATION_RETENTION_DAYS = 90;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NOTIFICATION_COLUMNS = `
id,
home_id,
recipient_membership_id,
source_outbox_event_id,
kind,
source_entity_type,
source_entity_id,
actor_membership_id,
occurred_at,
created_at,
read_at
`;

export const INSERT_NOTIFICATION_SQL = `
INSERT INTO notifications (
  id,
  home_id,
  recipient_membership_id,
  source_outbox_event_id,
  kind,
  source_entity_type,
  source_entity_id,
  actor_membership_id,
  occurred_at,
  created_at,
  read_at
)
VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5,
  $6,
  $7::uuid,
  $8::uuid,
  $9::timestamptz,
  $10::timestamptz,
  $11::timestamptz
)
RETURNING ${NOTIFICATION_COLUMNS}
`;

export const FIND_NOTIFICATION_BY_SOURCE_RECIPIENT_KIND_SQL = `
SELECT ${NOTIFICATION_COLUMNS}
FROM notifications
WHERE source_outbox_event_id = $1::uuid
  AND recipient_membership_id = $2::uuid
  AND kind = $3
LIMIT 2
`;

export const DELETE_NOTIFICATIONS_BY_RECIPIENT_MEMBERSHIP_SQL = `
DELETE FROM notifications
WHERE home_id = $1::uuid
  AND recipient_membership_id = $2::uuid
`;

export const DELETE_NOTIFICATIONS_BY_SOURCE_SQL = `
DELETE FROM notifications
WHERE home_id = $1::uuid
  AND source_entity_type = $2
  AND source_entity_id = $3::uuid
`;

export const PRUNE_EXPIRED_NOTIFICATIONS_SQL = `
DELETE FROM notifications
WHERE id IN (
  SELECT id
  FROM notifications
  WHERE occurred_at < $1::timestamptz
  ORDER BY occurred_at ASC, id ASC
  LIMIT $2
)
RETURNING id
`;

/**
 * Exact current-user recipient Membership predicate. Identity is the
 * authenticated User joined to an exact active Membership whose Home
 * matches the Notification. Capability never widens visibility. The
 * recipient account identifier is never persisted on notifications.
 */
export const NOTIFICATION_RECIPIENT_MEMBERSHIP_SQL = `
memberships.id = n.recipient_membership_id
AND memberships.user_id = $1::uuid
AND memberships.ended_at IS NULL
AND memberships.home_id = n.home_id
`;

export const NOTIFICATION_RECIPIENT_HOME_SQL = `
homes.id = memberships.home_id
AND homes.archived_at IS NULL
`;

/**
 * PRIVATE Maintenance remains list/update visible only while the canonical
 * source still exists, stays PRIVATE in the Notification Home, and the exact
 * recipient Membership remains in the immutable audience. HOUSEHOLD sources
 * never satisfy this predicate.
 */
export const NOTIFICATION_PRIVATE_MAINTENANCE_VISIBLE_SQL = `
(
  n.kind NOT IN (
    'PRIVATE_MAINTENANCE_CREATED',
    'PRIVATE_MAINTENANCE_RESOLVED'
  )
  OR (
    n.source_entity_type = 'MAINTENANCE'
    AND EXISTS (
      SELECT 1
      FROM maintenance_entries e
      WHERE e.id = n.source_entity_id
        AND e.home_id = n.home_id
        AND e.visibility = 'PRIVATE'
        AND EXISTS (
          SELECT 1
          FROM maintenance_audiences a
          WHERE a.home_id = e.home_id
            AND a.maintenance_entry_id = e.id
            AND a.membership_id = n.recipient_membership_id
        )
    )
  )
)
`;

const ELIGIBLE_NOTIFICATION_COLUMNS = `
n.id,
n.home_id,
n.recipient_membership_id,
n.source_outbox_event_id,
n.kind,
n.source_entity_type,
n.source_entity_id,
n.actor_membership_id,
n.occurred_at,
n.created_at,
n.read_at,
homes.name AS home_name
`;

/**
 * Visibility is applied before the cursor boundary, order, and LIMIT.
 */
export const LIST_ELIGIBLE_NOTIFICATION_PAGE_SQL = `
SELECT
  ${ELIGIBLE_NOTIFICATION_COLUMNS}
FROM notifications n
INNER JOIN memberships
  ON ${NOTIFICATION_RECIPIENT_MEMBERSHIP_SQL}
INNER JOIN homes
  ON ${NOTIFICATION_RECIPIENT_HOME_SQL}
WHERE ${NOTIFICATION_PRIVATE_MAINTENANCE_VISIBLE_SQL}
  AND (
    $3::uuid IS NULL
    OR (
      n.occurred_at < $2::timestamptz
      OR (
        n.occurred_at = $2::timestamptz
        AND n.id < $3::uuid
      )
    )
  )
ORDER BY
  n.occurred_at DESC,
  n.id DESC
LIMIT $4
`;

export const FIND_ELIGIBLE_NOTIFICATION_SQL = `
SELECT
  ${ELIGIBLE_NOTIFICATION_COLUMNS}
FROM notifications n
INNER JOIN memberships
  ON ${NOTIFICATION_RECIPIENT_MEMBERSHIP_SQL}
INNER JOIN homes
  ON ${NOTIFICATION_RECIPIENT_HOME_SQL}
WHERE n.id = $2::uuid
  AND ${NOTIFICATION_PRIVATE_MAINTENANCE_VISIBLE_SQL}
LIMIT 2
`;

export const MARK_ELIGIBLE_NOTIFICATION_READ_SQL = `
WITH eligible AS (
  SELECT n.id, n.read_at
  FROM notifications n
  INNER JOIN memberships
    ON ${NOTIFICATION_RECIPIENT_MEMBERSHIP_SQL}
  INNER JOIN homes
    ON ${NOTIFICATION_RECIPIENT_HOME_SQL}
  WHERE n.id = $2::uuid
    AND ${NOTIFICATION_PRIVATE_MAINTENANCE_VISIBLE_SQL}
),
updated AS (
  UPDATE notifications AS target
  SET read_at = transaction_timestamp()
  FROM eligible
  WHERE target.id = eligible.id
    AND eligible.read_at IS NULL
  RETURNING target.id, target.read_at
)
SELECT
  eligible.id,
  eligible.read_at AS previous_read_at,
  updated.read_at AS written_read_at
FROM eligible
LEFT JOIN updated ON updated.id = eligible.id
`;

export const FIND_ACTIVE_RECIPIENT_TENURES_SQL = `
SELECT
  memberships.id AS membership_id,
  memberships.home_id
FROM memberships
INNER JOIN homes
  ON homes.id = memberships.home_id
WHERE memberships.user_id = $1::uuid
  AND memberships.ended_at IS NULL
  AND homes.archived_at IS NULL
ORDER BY
  memberships.home_id ASC,
  memberships.id ASC
`;

/**
 * Visibility-first unread update. created_at is the cutoff, never occurred_at.
 * Hidden PRIVATE rows cannot enter the update relation.
 */
export const READ_ALL_ELIGIBLE_UNREAD_SQL = `
UPDATE notifications n
SET read_at = $2::timestamptz
FROM memberships
INNER JOIN homes
  ON ${NOTIFICATION_RECIPIENT_HOME_SQL}
WHERE ${NOTIFICATION_RECIPIENT_MEMBERSHIP_SQL}
  AND n.read_at IS NULL
  AND n.created_at <= $2::timestamptz
  AND ${NOTIFICATION_PRIVATE_MAINTENANCE_VISIBLE_SQL}
`;

export const SELECT_TRANSACTION_TIMESTAMP_SQL = `
SELECT transaction_timestamp() AS read_through
`;

export type NewNotification = Readonly<{
  id: string;
  homeId: string;
  recipientMembershipId: string;
  sourceOutboxEventId: string;
  kind: NotificationKind;
  sourceEntityType: NotificationSourceEntityType;
  sourceEntityId: string;
  actorMembershipId: string | null;
  occurredAt: Date;
  createdAt: Date;
  readAt?: Date | null;
}>;

export type NotificationInsertResult =
  | Readonly<{ outcome: 'inserted'; notification: Notification }>
  | Readonly<{
      outcome: 'duplicate_source_recipient_kind';
      sourceOutboxEventId: string;
      recipientMembershipId: string;
      kind: NotificationKind;
    }>;

export type NotificationSourceKey = Readonly<{
  sourceOutboxEventId: string;
  recipientMembershipId: string;
  kind: NotificationKind;
}>;

export type DeleteByRecipientMembership = Readonly<{
  homeId: string;
  recipientMembershipId: string;
}>;

export type DeleteBySource = Readonly<{
  homeId: string;
  sourceEntityType: NotificationSourceEntityType;
  sourceEntityId: string;
}>;

export type PruneExpiredNotifications = Readonly<{
  cutoff: Date;
  limit?: number;
}>;

export type NotificationPruneResult = Readonly<{
  deletedCount: number;
  ids: readonly string[];
}>;

export type ListEligibleNotificationPage = Readonly<{
  userId: string;
  limit: number;
  cursor?: string;
}>;

export type EligibleNotificationLookup = Readonly<{
  userId: string;
  notificationId: string;
}>;

export type ReadAllEligibleUnread = Readonly<{
  userId: string;
  readThrough: Date;
}>;

export type ActiveRecipientTenure = Readonly<{
  membershipId: string;
  homeId: string;
}>;

export type MarkEligibleNotificationReadResult =
  | Readonly<{ outcome: 'not_found' }>
  | Readonly<{ outcome: 'already_read'; readAt: Date }>
  | Readonly<{ outcome: 'marked'; readAt: Date }>;

export type NotificationRepository = Readonly<{
  insertNotification(
    tx: TransactionContext,
    notification: NewNotification,
  ): Promise<NotificationInsertResult>;
  insertNotifications(
    tx: TransactionContext,
    notifications: readonly NewNotification[],
  ): Promise<readonly NotificationInsertResult[]>;
  findBySourceRecipientKind(
    tx: TransactionContext,
    key: NotificationSourceKey,
  ): Promise<Notification | null>;
  deleteByRecipientMembership(
    tx: TransactionContext,
    input: DeleteByRecipientMembership,
  ): Promise<number>;
  deleteBySource(
    tx: TransactionContext,
    input: DeleteBySource,
  ): Promise<number>;
  pruneExpired(
    tx: TransactionContext,
    input: PruneExpiredNotifications,
  ): Promise<NotificationPruneResult>;
  listEligiblePageForUser(
    input: ListEligibleNotificationPage,
  ): Promise<NotificationRepositoryPage>;
  markEligibleRead(
    tx: TransactionContext,
    input: EligibleNotificationLookup,
  ): Promise<MarkEligibleNotificationReadResult>;
  findActiveRecipientTenures(
    tx: TransactionContext,
    userId: string,
  ): Promise<readonly ActiveRecipientTenure[]>;
  readTransactionTimestamp(tx: TransactionContext): Promise<Date>;
  readAllEligibleUnread(
    tx: TransactionContext,
    input: ReadAllEligibleUnread,
  ): Promise<void>;
}>;

type NotificationRow = {
  id: unknown;
  home_id: unknown;
  recipient_membership_id: unknown;
  source_outbox_event_id: unknown;
  kind: unknown;
  source_entity_type: unknown;
  source_entity_id: unknown;
  actor_membership_id: unknown;
  occurred_at: unknown;
  created_at: unknown;
  read_at: unknown;
};

type EligibleNotificationRow = NotificationRow & {
  home_name: unknown;
};

type MarkReadRow = {
  id: unknown;
  previous_read_at: unknown;
  written_read_at: unknown;
};

type ActiveRecipientTenureRow = {
  membership_id: unknown;
  home_id: unknown;
};

function hasConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

function isPostgresSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '40001'
  );
}

function rethrowQueryFailure(error: unknown): never {
  if (isPostgresSerializationFailure(error)) {
    throw error;
  }
  if (error instanceof NotificationPersistenceError) {
    throw error;
  }
  throw new NotificationPersistenceError();
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}

function optionalUuid(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (isUuid(value)) {
    return value;
  }
  throw new NotificationPersistenceError();
}

function optionalDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new NotificationPersistenceError();
}

function parseEligibleNotificationRow(
  row: EligibleNotificationRow,
): EligibleNotification {
  const notification = parseNotificationRow(row);
  if (typeof row.home_name !== 'string' || row.home_name.length === 0) {
    throw new NotificationPersistenceError();
  }
  return Object.freeze({
    ...notification,
    homeName: row.home_name,
  });
}

function parseNotificationRow(row: NotificationRow): Notification {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    !isUuid(row.recipient_membership_id) ||
    !isUuid(row.source_outbox_event_id) ||
    !isNotificationKind(row.kind) ||
    !isNotificationSourceEntityType(row.source_entity_type) ||
    !isUuid(row.source_entity_id) ||
    !isDate(row.occurred_at) ||
    !isDate(row.created_at)
  ) {
    throw new NotificationPersistenceError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    recipientMembershipId: row.recipient_membership_id,
    sourceOutboxEventId: row.source_outbox_event_id,
    kind: row.kind,
    sourceEntityType: row.source_entity_type,
    sourceEntityId: row.source_entity_id,
    actorMembershipId: optionalUuid(row.actor_membership_id),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    readAt: optionalDate(row.read_at),
  });
}

function oneNotification(rows: readonly NotificationRow[]): Notification {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new NotificationPersistenceError();
  }
  return parseNotificationRow(rows[0]);
}

function oneOrNullNotification(
  rows: readonly NotificationRow[],
): Notification | null {
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new NotificationPersistenceError();
  }
  return parseNotificationRow(rows[0]);
}

function assertNewNotification(notification: NewNotification): void {
  if (
    !isUuid(notification.id) ||
    !isUuid(notification.homeId) ||
    !isUuid(notification.recipientMembershipId) ||
    !isUuid(notification.sourceOutboxEventId) ||
    !isNotificationKind(notification.kind) ||
    !isNotificationSourceEntityType(notification.sourceEntityType) ||
    !isUuid(notification.sourceEntityId) ||
    (notification.actorMembershipId !== null &&
      !isUuid(notification.actorMembershipId)) ||
    !isDate(notification.occurredAt) ||
    !isDate(notification.createdAt) ||
    (notification.readAt !== undefined &&
      notification.readAt !== null &&
      !isDate(notification.readAt))
  ) {
    throw new NotificationPersistenceError();
  }
  if (
    !isNotificationKindSourceCompatible(
      notification.kind,
      notification.sourceEntityType,
    )
  ) {
    throw new NotificationPersistenceError();
  }
}

function insertParams(notification: NewNotification): unknown[] {
  return [
    notification.id,
    notification.homeId,
    notification.recipientMembershipId,
    notification.sourceOutboxEventId,
    notification.kind,
    notification.sourceEntityType,
    notification.sourceEntityId,
    notification.actorMembershipId,
    notification.occurredAt,
    notification.createdAt,
    notification.readAt ?? null,
  ];
}

function orderedNotifications(
  notifications: readonly NewNotification[],
): NewNotification[] {
  return [...notifications].sort((left, right) => {
    if (left.recipientMembershipId !== right.recipientMembershipId) {
      return left.recipientMembershipId < right.recipientMembershipId ? -1 : 1;
    }
    if (left.kind !== right.kind) {
      return left.kind < right.kind ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

async function insertOne(
  tx: TransactionContext,
  notification: NewNotification,
): Promise<NotificationInsertResult> {
  assertNewNotification(notification);
  try {
    await tx.query('SAVEPOINT notification_insert');
  } catch {
    throw new NotificationPersistenceError();
  }

  try {
    const inserted = await tx.query<NotificationRow>(
      INSERT_NOTIFICATION_SQL,
      insertParams(notification),
    );
    const stored = oneNotification(inserted.rows);
    try {
      await tx.query('RELEASE SAVEPOINT notification_insert');
    } catch {
      throw new NotificationPersistenceError();
    }
    return Object.freeze({ outcome: 'inserted', notification: stored });
  } catch (error) {
    try {
      await tx.query('ROLLBACK TO SAVEPOINT notification_insert');
      await tx.query('RELEASE SAVEPOINT notification_insert');
    } catch {
      throw new NotificationPersistenceError();
    }
    if (
      hasConstraint(error, NOTIFICATION_SOURCE_RECIPIENT_KIND_UNIQUE_CONSTRAINT)
    ) {
      return Object.freeze({
        outcome: 'duplicate_source_recipient_kind',
        sourceOutboxEventId: notification.sourceOutboxEventId,
        recipientMembershipId: notification.recipientMembershipId,
        kind: notification.kind,
      });
    }
    if (error instanceof NotificationPersistenceError) {
      throw error;
    }
    throw new NotificationPersistenceError();
  }
}

export function createNotificationRepository(
  pool: Pool,
): NotificationRepository {
  return Object.freeze({
    async insertNotification(tx, notification) {
      return insertOne(tx, notification);
    },

    async insertNotifications(tx, notifications) {
      const ordered = orderedNotifications(notifications);
      const results: NotificationInsertResult[] = [];
      for (const notification of ordered) {
        results.push(await insertOne(tx, notification));
      }
      return Object.freeze(results);
    },

    async findBySourceRecipientKind(tx, key) {
      if (
        !isUuid(key.sourceOutboxEventId) ||
        !isUuid(key.recipientMembershipId) ||
        !isNotificationKind(key.kind)
      ) {
        throw new NotificationPersistenceError();
      }
      try {
        const result = await tx.query<NotificationRow>(
          FIND_NOTIFICATION_BY_SOURCE_RECIPIENT_KIND_SQL,
          [key.sourceOutboxEventId, key.recipientMembershipId, key.kind],
        );
        return oneOrNullNotification(result.rows);
      } catch (error) {
        if (error instanceof NotificationPersistenceError) {
          throw error;
        }
        throw new NotificationPersistenceError();
      }
    },

    async deleteByRecipientMembership(tx, input) {
      if (!isUuid(input.homeId) || !isUuid(input.recipientMembershipId)) {
        throw new NotificationPersistenceError();
      }
      try {
        const result = await tx.query(
          DELETE_NOTIFICATIONS_BY_RECIPIENT_MEMBERSHIP_SQL,
          [input.homeId, input.recipientMembershipId],
        );
        return result.rowCount ?? 0;
      } catch {
        throw new NotificationPersistenceError();
      }
    },

    async deleteBySource(tx, input) {
      if (
        !isUuid(input.homeId) ||
        !isNotificationSourceEntityType(input.sourceEntityType) ||
        !isUuid(input.sourceEntityId)
      ) {
        throw new NotificationPersistenceError();
      }
      try {
        const result = await tx.query(DELETE_NOTIFICATIONS_BY_SOURCE_SQL, [
          input.homeId,
          input.sourceEntityType,
          input.sourceEntityId,
        ]);
        return result.rowCount ?? 0;
      } catch {
        throw new NotificationPersistenceError();
      }
    },

    async pruneExpired(tx, input) {
      const limit = input.limit ?? NOTIFICATION_PRUNE_BATCH_SIZE;
      if (
        !isDate(input.cutoff) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > NOTIFICATION_PRUNE_BATCH_SIZE
      ) {
        throw new NotificationPersistenceError();
      }
      try {
        const result = await tx.query<{ id: unknown }>(
          PRUNE_EXPIRED_NOTIFICATIONS_SQL,
          [input.cutoff, limit],
        );
        const ids = result.rows.map((row) => {
          if (!isUuid(row.id)) {
            throw new NotificationPersistenceError();
          }
          return row.id;
        });
        return Object.freeze({
          deletedCount: ids.length,
          ids: Object.freeze(ids),
        });
      } catch (error) {
        if (error instanceof NotificationPersistenceError) {
          throw error;
        }
        throw new NotificationPersistenceError();
      }
    },

    async listEligiblePageForUser(input) {
      if (!isUuid(input.userId)) {
        throw new NotificationPersistenceError();
      }
      const limit = assertNotificationListLimit(input.limit);
      const cursor =
        input.cursor === undefined
          ? null
          : bindNotificationListCursor(input.cursor, {
              userId: input.userId,
              queryFingerprint: NOTIFICATION_LIST_QUERY_FINGERPRINT,
            });
      try {
        const result = await pool.query<EligibleNotificationRow>(
          LIST_ELIGIBLE_NOTIFICATION_PAGE_SQL,
          [
            input.userId,
            cursor === null ? null : new Date(cursor.occurredAt),
            cursor?.id ?? null,
            limit + 1,
          ],
        );
        const parsed = result.rows.map((row) =>
          parseEligibleNotificationRow(row),
        );
        const hasMore = parsed.length > limit;
        const items = Object.freeze(hasMore ? parsed.slice(0, limit) : parsed);
        const last = items[items.length - 1];
        const nextCursor =
          hasMore && last !== undefined
            ? encodeNotificationListCursor({
                v: 1,
                occurredAt: last.occurredAt.toISOString(),
                id: last.id,
                userId: input.userId,
                queryFingerprint: NOTIFICATION_LIST_QUERY_FINGERPRINT,
              })
            : null;
        return Object.freeze({
          items,
          hasMore,
          nextCursor,
        });
      } catch (error) {
        if (
          error instanceof NotificationPersistenceError ||
          error instanceof InvalidNotificationRequestError
        ) {
          throw error;
        }
        throw new NotificationPersistenceError();
      }
    },

    async markEligibleRead(tx, input) {
      if (!isUuid(input.userId) || !isUuid(input.notificationId)) {
        throw new NotificationPersistenceError();
      }
      try {
        const result = await tx.query<MarkReadRow>(
          MARK_ELIGIBLE_NOTIFICATION_READ_SQL,
          [input.userId, input.notificationId],
        );
        if (result.rows.length === 0) {
          return Object.freeze({ outcome: 'not_found' });
        }
        if (result.rows.length !== 1 || result.rows[0] === undefined) {
          throw new NotificationPersistenceError();
        }
        const row = result.rows[0];
        if (row.written_read_at !== null) {
          if (!isDate(row.written_read_at)) {
            throw new NotificationPersistenceError();
          }
          return Object.freeze({
            outcome: 'marked',
            readAt: row.written_read_at,
          });
        }
        if (!isDate(row.previous_read_at)) {
          throw new NotificationPersistenceError();
        }
        return Object.freeze({
          outcome: 'already_read',
          readAt: row.previous_read_at,
        });
      } catch (error) {
        if (error instanceof NotificationPersistenceError) {
          throw error;
        }
        throw new NotificationPersistenceError();
      }
    },

    async findActiveRecipientTenures(tx, userId) {
      if (!isUuid(userId)) {
        throw new NotificationPersistenceError();
      }
      try {
        const result = await tx.query<ActiveRecipientTenureRow>(
          FIND_ACTIVE_RECIPIENT_TENURES_SQL,
          [userId],
        );
        return Object.freeze(
          result.rows.map((row) => {
            if (!isUuid(row.membership_id) || !isUuid(row.home_id)) {
              throw new NotificationPersistenceError();
            }
            return Object.freeze({
              membershipId: row.membership_id,
              homeId: row.home_id,
            });
          }),
        );
      } catch (error) {
        rethrowQueryFailure(error);
      }
    },

    async readTransactionTimestamp(tx) {
      try {
        const result = await tx.query<{ read_through: unknown }>(
          SELECT_TRANSACTION_TIMESTAMP_SQL,
        );
        const row = result.rows[0];
        if (
          result.rows.length !== 1 ||
          row === undefined ||
          !isDate(row.read_through)
        ) {
          throw new NotificationPersistenceError();
        }
        return row.read_through;
      } catch (error) {
        rethrowQueryFailure(error);
      }
    },

    async readAllEligibleUnread(tx, input) {
      if (!isUuid(input.userId) || !isDate(input.readThrough)) {
        throw new NotificationPersistenceError();
      }
      try {
        await tx.query(READ_ALL_ELIGIBLE_UNREAD_SQL, [
          input.userId,
          input.readThrough,
        ]);
      } catch (error) {
        rethrowQueryFailure(error);
      }
    },
  });
}
