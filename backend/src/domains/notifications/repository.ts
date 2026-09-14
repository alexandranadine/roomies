import type { Pool } from 'pg';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { NotificationPersistenceError } from './errors.js';
import {
  isNotificationKind,
  isNotificationKindSourceCompatible,
  isNotificationSourceEntityType,
  type Notification,
  type NotificationKind,
  type NotificationSourceEntityType,
} from './notification.js';

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
  void pool;
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
  });
}
