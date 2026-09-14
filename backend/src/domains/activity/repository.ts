import type { Pool } from 'pg';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  isActivitySourceEntityType,
  isActivityVisibilityClass,
  isValidActivityEventType,
  type Activity,
  type ActivitySourceEntityType,
  type ActivityVisibilityClass,
} from './activity.js';
import {
  ActivityPersistenceError,
  EmptyActivityRecipientSetError,
  InvalidActivityRequestError,
} from './errors.js';
import type { ActivityRepositoryPage } from './activity-list-item.js';
import {
  ACTIVITY_LIST_QUERY_FINGERPRINT,
  assertActivityListLimit,
  bindActivityListCursor,
  encodeActivityListCursor,
} from './cursor.js';

/**
 * Deployed UNIQUE index for source_outbox_event_id. Idempotency recognizes
 * only this named constraint. Arbitrary unique violations are not duplicates.
 */
export const ACTIVITY_SOURCE_OUTBOX_EVENT_UNIQUE_CONSTRAINT =
  'activities_source_outbox_event_id_key_17bba872';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIVITY_COLUMNS = `
id,
home_id,
source_outbox_event_id,
source_entity_type,
source_entity_id,
event_type,
visibility_class,
actor_membership_id,
occurred_at,
created_at
`;

const VISIBLE_ACTIVITY_COLUMNS = `
a.id,
a.home_id,
a.source_outbox_event_id,
a.source_entity_type,
a.source_entity_id,
a.event_type,
a.visibility_class,
a.actor_membership_id,
a.occurred_at,
a.created_at
`;

/**
 * Canonical actor-scope predicate. Identity is exact active Membership tenure
 * in an unarchived Home. No role/Admin/userId branch.
 */
export const ACTIVITY_ACTOR_SCOPE_SQL = `
memberships.home_id = $1::uuid
AND memberships.id = $2::uuid
AND memberships.ended_at IS NULL
AND homes.id = $1::uuid
AND homes.archived_at IS NULL
`;

/**
 * Canonical visible-Activity predicate. HOME_VISIBLE or SOURCE_AUTHORIZED
 * plus the exact ActivityRecipient row. No Admin/role/userId/source-domain
 * branch. Suitable for visibility, then cursor, then order, then limit.
 *
 * Cross-row visibility-class/recipient cardinality invariant is repository +
 * transaction enforced, not trigger enforced. Direct arbitrary SQL can
 * violate HOME_VISIBLE=0 recipients / SOURCE_AUTHORIZED>=1 recipients.
 */
export const ACTIVITY_VISIBLE_PREDICATE_SQL = `
(
  a.visibility_class = 'HOME_VISIBLE'
  OR (
    a.visibility_class = 'SOURCE_AUTHORIZED'
    AND EXISTS (
      SELECT 1
      FROM activity_recipients r
      WHERE r.home_id = a.home_id
        AND r.activity_id = a.id
        AND r.membership_id = $2::uuid
    )
  )
)
`;

export const INSERT_ACTIVITY_SQL = `
INSERT INTO activities (
  id,
  home_id,
  source_outbox_event_id,
  source_entity_type,
  source_entity_id,
  event_type,
  visibility_class,
  actor_membership_id,
  occurred_at,
  created_at
)
VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5::uuid,
  $6,
  $7,
  $8::uuid,
  $9::timestamptz,
  $10::timestamptz
)
RETURNING ${ACTIVITY_COLUMNS}
`;

const INSERT_ACTIVITY_RECIPIENT_SET_SQL = `
INSERT INTO activity_recipients (
  home_id,
  activity_id,
  membership_id,
  created_at
)
SELECT $1::uuid, $2::uuid, u.membership_id, $3::timestamptz
FROM unnest($4::uuid[]) AS u(membership_id)
ORDER BY u.membership_id ASC
`;

export const FIND_ACTIVITY_BY_SOURCE_OUTBOX_EVENT_ID_SQL = `
SELECT ${ACTIVITY_COLUMNS}
FROM activities
WHERE source_outbox_event_id = $1::uuid
LIMIT 2
`;

export const FIND_VISIBLE_ACTIVITY_SQL = `
SELECT ${VISIBLE_ACTIVITY_COLUMNS}
FROM memberships
INNER JOIN homes
  ON homes.id = memberships.home_id
INNER JOIN activities a
  ON a.home_id = $1::uuid
 AND a.id = $3::uuid
WHERE ${ACTIVITY_ACTOR_SCOPE_SQL}
  AND a.home_id = $1::uuid
  AND ${ACTIVITY_VISIBLE_PREDICATE_SQL}
LIMIT 2
`;

export const LIST_VISIBLE_ACTIVITIES_SQL = `
WITH actor_scope AS (
  SELECT memberships.id AS actor_membership_id
  FROM memberships
  INNER JOIN homes
    ON homes.id = memberships.home_id
  WHERE ${ACTIVITY_ACTOR_SCOPE_SQL}
),
visible_activities AS (
  SELECT
    ${VISIBLE_ACTIVITY_COLUMNS}
  FROM actor_scope
  INNER JOIN activities a
    ON a.home_id = $1::uuid
  WHERE ${ACTIVITY_VISIBLE_PREDICATE_SQL}
  ORDER BY
    a.occurred_at DESC,
    a.id DESC
)
SELECT
  actor_scope.actor_membership_id AS querying_actor_membership_id,
  visible_activities.id,
  visible_activities.home_id,
  visible_activities.source_outbox_event_id,
  visible_activities.source_entity_type,
  visible_activities.source_entity_id,
  visible_activities.event_type,
  visible_activities.visibility_class,
  visible_activities.actor_membership_id,
  visible_activities.occurred_at,
  visible_activities.created_at
FROM actor_scope
LEFT JOIN visible_activities ON TRUE
`;

/**
 * Paginated visible-Activity page. Visibility is applied inside the CTE
 * before the cursor boundary, order, and LIMIT. Actor-scope miss returns
 * zero rows so the repository can conceal the Home.
 */
export const LIST_VISIBLE_ACTIVITY_PAGE_SQL = `
WITH actor_scope AS (
  SELECT memberships.id AS actor_membership_id
  FROM memberships
  INNER JOIN homes
    ON homes.id = memberships.home_id
  WHERE ${ACTIVITY_ACTOR_SCOPE_SQL}
),
visible_activities AS (
  SELECT
    ${VISIBLE_ACTIVITY_COLUMNS}
  FROM actor_scope
  INNER JOIN activities a
    ON a.home_id = $1::uuid
  WHERE ${ACTIVITY_VISIBLE_PREDICATE_SQL}
    AND (
      $4::uuid IS NULL
      OR (
        a.occurred_at < $3::timestamptz
        OR (
          a.occurred_at = $3::timestamptz
          AND a.id < $4::uuid
        )
      )
    )
  ORDER BY
    a.occurred_at DESC,
    a.id DESC
  LIMIT $5
)
SELECT
  actor_scope.actor_membership_id AS querying_actor_membership_id,
  visible_activities.id,
  visible_activities.home_id,
  visible_activities.source_outbox_event_id,
  visible_activities.source_entity_type,
  visible_activities.source_entity_id,
  visible_activities.event_type,
  visible_activities.visibility_class,
  visible_activities.actor_membership_id,
  visible_activities.occurred_at,
  visible_activities.created_at
FROM actor_scope
LEFT JOIN visible_activities ON TRUE
`;

export type NewActivity = Readonly<{
  id: string;
  homeId: string;
  sourceOutboxEventId: string;
  sourceEntityType: ActivitySourceEntityType;
  sourceEntityId: string;
  eventType: string;
  actorMembershipId: string | null;
  occurredAt: Date;
  createdAt: Date;
}>;

export type ActivityInsertResult =
  | Readonly<{ outcome: 'inserted'; activity: Activity }>
  | Readonly<{
      outcome: 'duplicate_source_outbox_event';
      sourceOutboxEventId: string;
    }>;

export type ActivityRepository = Readonly<{
  insertHomeVisibleActivity(
    tx: TransactionContext,
    activity: NewActivity,
  ): Promise<ActivityInsertResult>;
  insertSourceAuthorizedActivity(
    tx: TransactionContext,
    activity: NewActivity,
    recipientMembershipIds: readonly string[],
  ): Promise<ActivityInsertResult>;
  findBySourceOutboxEventId(
    sourceOutboxEventId: string,
  ): Promise<Activity | null>;
  findVisibleByHomeAndId(
    homeId: string,
    activityId: string,
    actorMembershipId: string,
  ): Promise<Activity | null>;
  listVisibleByHome(
    homeId: string,
    actorMembershipId: string,
  ): Promise<readonly Activity[] | null>;
  listVisiblePageByHome(
    input: ListVisibleActivityPage,
  ): Promise<ActivityRepositoryPage | null>;
}>;

export type ListVisibleActivityPage = Readonly<{
  homeId: string;
  actorMembershipId: string;
  limit: number;
  cursor?: string;
}>;

type ActivityRow = {
  id: unknown;
  home_id: unknown;
  source_outbox_event_id: unknown;
  source_entity_type: unknown;
  source_entity_id: unknown;
  event_type: unknown;
  visibility_class: unknown;
  actor_membership_id: unknown;
  occurred_at: unknown;
  created_at: unknown;
};

type ActivityListRow = ActivityRow & {
  querying_actor_membership_id: unknown;
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
  throw new ActivityPersistenceError();
}

function parseActivityRow(row: ActivityRow, homeId?: string): Activity {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    (homeId !== undefined && row.home_id !== homeId) ||
    !isUuid(row.source_outbox_event_id) ||
    !isActivitySourceEntityType(row.source_entity_type) ||
    !isUuid(row.source_entity_id) ||
    !isValidActivityEventType(row.event_type) ||
    !isActivityVisibilityClass(row.visibility_class) ||
    !isDate(row.occurred_at) ||
    !isDate(row.created_at)
  ) {
    throw new ActivityPersistenceError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    sourceOutboxEventId: row.source_outbox_event_id,
    sourceEntityType: row.source_entity_type,
    sourceEntityId: row.source_entity_id,
    eventType: row.event_type,
    visibilityClass: row.visibility_class,
    actorMembershipId: optionalUuid(row.actor_membership_id),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  });
}

function oneActivity(rows: readonly ActivityRow[], homeId: string): Activity {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new ActivityPersistenceError();
  }
  return parseActivityRow(rows[0], homeId);
}

function oneOrNullActivity(rows: readonly ActivityRow[]): Activity | null {
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new ActivityPersistenceError();
  }
  return parseActivityRow(rows[0]);
}

function orderedUniqueMembershipIds(
  membershipIds: readonly string[],
): string[] {
  const unique = new Set<string>();
  for (const membershipId of membershipIds) {
    if (!isUuid(membershipId)) {
      throw new ActivityPersistenceError();
    }
    unique.add(membershipId);
  }
  return [...unique].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function assertNewActivity(activity: NewActivity): void {
  if (
    !isUuid(activity.id) ||
    !isUuid(activity.homeId) ||
    !isUuid(activity.sourceOutboxEventId) ||
    !isActivitySourceEntityType(activity.sourceEntityType) ||
    !isUuid(activity.sourceEntityId) ||
    !isValidActivityEventType(activity.eventType) ||
    (activity.actorMembershipId !== null &&
      !isUuid(activity.actorMembershipId)) ||
    !isDate(activity.occurredAt) ||
    !isDate(activity.createdAt)
  ) {
    throw new ActivityPersistenceError();
  }
}

function insertParams(
  activity: NewActivity,
  visibilityClass: ActivityVisibilityClass,
): unknown[] {
  return [
    activity.id,
    activity.homeId,
    activity.sourceOutboxEventId,
    activity.sourceEntityType,
    activity.sourceEntityId,
    activity.eventType,
    visibilityClass,
    activity.actorMembershipId,
    activity.occurredAt,
    activity.createdAt,
  ];
}

async function insertActivityWithOptionalRecipients(
  tx: TransactionContext,
  activity: NewActivity,
  visibilityClass: ActivityVisibilityClass,
  recipientMembershipIds: readonly string[],
): Promise<ActivityInsertResult> {
  assertNewActivity(activity);
  try {
    await tx.query('SAVEPOINT activity_insert');
  } catch {
    throw new ActivityPersistenceError();
  }

  try {
    const inserted = await tx.query<ActivityRow>(
      INSERT_ACTIVITY_SQL,
      insertParams(activity, visibilityClass),
    );
    const stored = oneActivity(inserted.rows, activity.homeId);
    if (visibilityClass === 'SOURCE_AUTHORIZED') {
      await tx.query(INSERT_ACTIVITY_RECIPIENT_SET_SQL, [
        stored.homeId,
        stored.id,
        stored.createdAt,
        recipientMembershipIds,
      ]);
    }
    try {
      await tx.query('RELEASE SAVEPOINT activity_insert');
    } catch {
      throw new ActivityPersistenceError();
    }
    return Object.freeze({ outcome: 'inserted', activity: stored });
  } catch (error) {
    if (hasConstraint(error, ACTIVITY_SOURCE_OUTBOX_EVENT_UNIQUE_CONSTRAINT)) {
      try {
        await tx.query('ROLLBACK TO SAVEPOINT activity_insert');
        await tx.query('RELEASE SAVEPOINT activity_insert');
      } catch {
        throw new ActivityPersistenceError();
      }
      return Object.freeze({
        outcome: 'duplicate_source_outbox_event',
        sourceOutboxEventId: activity.sourceOutboxEventId,
      });
    }
    if (
      error instanceof ActivityPersistenceError ||
      error instanceof EmptyActivityRecipientSetError
    ) {
      throw error;
    }
    throw new ActivityPersistenceError();
  }
}

export function createActivityRepository(pool: Pool): ActivityRepository {
  return Object.freeze({
    async insertHomeVisibleActivity(tx, activity) {
      return insertActivityWithOptionalRecipients(
        tx,
        activity,
        'HOME_VISIBLE',
        [],
      );
    },

    async insertSourceAuthorizedActivity(tx, activity, recipientMembershipIds) {
      const recipients = orderedUniqueMembershipIds(recipientMembershipIds);
      if (recipients.length === 0) {
        throw new EmptyActivityRecipientSetError();
      }
      return insertActivityWithOptionalRecipients(
        tx,
        activity,
        'SOURCE_AUTHORIZED',
        recipients,
      );
    },

    async findBySourceOutboxEventId(sourceOutboxEventId) {
      if (!isUuid(sourceOutboxEventId)) {
        throw new ActivityPersistenceError();
      }
      try {
        const result = await pool.query<ActivityRow>(
          FIND_ACTIVITY_BY_SOURCE_OUTBOX_EVENT_ID_SQL,
          [sourceOutboxEventId],
        );
        return oneOrNullActivity(result.rows);
      } catch (error) {
        if (error instanceof ActivityPersistenceError) {
          throw error;
        }
        throw new ActivityPersistenceError();
      }
    },

    async findVisibleByHomeAndId(homeId, activityId, actorMembershipId) {
      try {
        const result = await pool.query<ActivityRow>(
          FIND_VISIBLE_ACTIVITY_SQL,
          [homeId, actorMembershipId, activityId],
        );
        return oneOrNullActivity(result.rows);
      } catch (error) {
        if (error instanceof ActivityPersistenceError) {
          throw error;
        }
        throw new ActivityPersistenceError();
      }
    },

    async listVisibleByHome(homeId, actorMembershipId) {
      try {
        const result = await pool.query<ActivityListRow>(
          LIST_VISIBLE_ACTIVITIES_SQL,
          [homeId, actorMembershipId],
        );
        if (result.rows.length === 0) {
          return null;
        }
        if (result.rows.length === 1 && result.rows[0]?.id === null) {
          return Object.freeze([]);
        }
        return Object.freeze(
          result.rows.map((row) => parseActivityRow(row, homeId)),
        );
      } catch (error) {
        if (error instanceof ActivityPersistenceError) {
          throw error;
        }
        throw new ActivityPersistenceError();
      }
    },

    async listVisiblePageByHome(input) {
      const limit = assertActivityListLimit(input.limit);
      const cursor =
        input.cursor === undefined
          ? null
          : bindActivityListCursor(input.cursor, {
              homeId: input.homeId,
              actorMembershipId: input.actorMembershipId,
              queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
            });
      try {
        const result = await pool.query<ActivityListRow>(
          LIST_VISIBLE_ACTIVITY_PAGE_SQL,
          [
            input.homeId,
            input.actorMembershipId,
            cursor === null ? null : new Date(cursor.occurredAt),
            cursor?.id ?? null,
            limit + 1,
          ],
        );
        if (result.rows.length === 0) {
          return null;
        }
        if (result.rows.length === 1 && result.rows[0]?.id === null) {
          return Object.freeze({
            items: Object.freeze([]),
            hasMore: false,
            nextCursor: null,
          });
        }
        const parsed = result.rows.map((row) => {
          if (!isUuid(row.querying_actor_membership_id)) {
            throw new ActivityPersistenceError();
          }
          return parseActivityRow(row, input.homeId);
        });
        const hasMore = parsed.length > limit;
        const items = Object.freeze(hasMore ? parsed.slice(0, limit) : parsed);
        const last = items[items.length - 1];
        const nextCursor =
          hasMore && last !== undefined
            ? encodeActivityListCursor({
                v: 1,
                occurredAt: last.occurredAt.toISOString(),
                id: last.id,
                homeId: input.homeId,
                actorMembershipId: input.actorMembershipId,
                queryFingerprint: ACTIVITY_LIST_QUERY_FINGERPRINT,
              })
            : null;
        return Object.freeze({
          items,
          hasMore,
          nextCursor,
        });
      } catch (error) {
        if (
          error instanceof ActivityPersistenceError ||
          error instanceof InvalidActivityRequestError
        ) {
          throw error;
        }
        throw new ActivityPersistenceError();
      }
    },
  });
}
