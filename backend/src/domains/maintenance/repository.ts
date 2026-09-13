import type { Pool } from 'pg';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  assertMaintenanceListLimit,
  bindMaintenanceListCursor,
  encodeMaintenanceListCursor,
  MAINTENANCE_LIST_QUERY_FINGERPRINT,
} from './cursor.js';
import {
  InvalidMaintenanceRequestError,
  MaintenancePersistenceError,
} from './errors.js';
import {
  isMaintenanceStatus,
  isMaintenanceVisibility,
  isValidMaintenanceLifecycle,
  maintenanceStatusRank,
  type MaintenanceDetailProjection,
  type MaintenanceEntry,
  type MaintenanceListItemProjection,
  type MaintenanceStatus,
  type MaintenanceVisibility,
} from './maintenance.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAINTENANCE_ENTRY_COLUMNS = `
id,
home_id,
created_by_membership_id,
visibility,
title,
details,
status,
resolved_by_membership_id,
resolved_at,
created_at,
updated_at
`;

const MAINTENANCE_DETAIL_COLUMNS = `
e.id,
e.title,
e.details,
e.status,
e.visibility,
e.created_by_membership_id,
e.resolved_by_membership_id,
e.resolved_at,
e.created_at,
e.updated_at
`;

const MAINTENANCE_LIST_COLUMNS = `
e.id,
e.title,
e.status,
e.visibility,
e.created_by_membership_id,
e.resolved_by_membership_id,
e.resolved_at,
e.created_at,
e.updated_at,
CASE e.status WHEN 'OPEN' THEN 0 WHEN 'RESOLVED' THEN 1 END AS status_rank
`;

/**
 * Canonical actor-scope predicate. Reused by every visible Maintenance
 * relation. Identity is exact Membership tenure. No role/Admin/userId branch.
 */
export const MAINTENANCE_ACTOR_SCOPE_SQL = `
memberships.home_id = $1::uuid
AND memberships.id = $2::uuid
AND memberships.ended_at IS NULL
AND homes.id = $1::uuid
AND homes.archived_at IS NULL
`;

/**
 * Canonical visible-entries predicate. HOUSEHOLD or PRIVATE+audience EXISTS.
 * No creator exception. No Admin/role/userId branch.
 */
export const MAINTENANCE_VISIBLE_PREDICATE_SQL = `
(
  e.visibility = 'HOUSEHOLD'
  OR (
    e.visibility = 'PRIVATE'
    AND EXISTS (
      SELECT 1
      FROM maintenance_audiences a
      WHERE a.home_id = e.home_id
        AND a.maintenance_entry_id = e.id
        AND a.membership_id = $2::uuid
    )
  )
)
`;

export const MAINTENANCE_STATUS_RANK_SQL = `
CASE e.status WHEN 'OPEN' THEN 0 WHEN 'RESOLVED' THEN 1 END
`;

export const INSERT_MAINTENANCE_ENTRY_SQL = `
INSERT INTO maintenance_entries (
  id,
  home_id,
  created_by_membership_id,
  visibility,
  title,
  details,
  status,
  resolved_by_membership_id,
  resolved_at,
  created_at,
  updated_at
)
VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6,
  $7,
  $8::uuid,
  $9::timestamptz,
  $10::timestamptz,
  $11::timestamptz
)
RETURNING ${MAINTENANCE_ENTRY_COLUMNS}
`;

const INSERT_MAINTENANCE_AUDIENCE_SET_SQL = `
INSERT INTO maintenance_audiences (
  home_id,
  maintenance_entry_id,
  membership_id,
  created_at
)
SELECT $1::uuid, $2::uuid, u.membership_id, $3::timestamptz
FROM unnest($4::uuid[]) AS u(membership_id)
ORDER BY u.membership_id ASC
`;

export const FIND_VISIBLE_MAINTENANCE_ENTRY_SQL = `
SELECT ${MAINTENANCE_DETAIL_COLUMNS}
FROM memberships
INNER JOIN homes
  ON homes.id = memberships.home_id
INNER JOIN maintenance_entries e
  ON e.home_id = $1::uuid
 AND e.id = $3::uuid
WHERE ${MAINTENANCE_ACTOR_SCOPE_SQL}
  AND e.home_id = $1::uuid
  AND ${MAINTENANCE_VISIBLE_PREDICATE_SQL}
LIMIT 2
`;

export const LOCK_VISIBLE_MAINTENANCE_ENTRY_FOR_RESOLVE_SQL = `
SELECT ${MAINTENANCE_DETAIL_COLUMNS}
FROM memberships
INNER JOIN homes
  ON homes.id = memberships.home_id
INNER JOIN maintenance_entries e
  ON e.home_id = $1::uuid
 AND e.id = $3::uuid
WHERE ${MAINTENANCE_ACTOR_SCOPE_SQL}
  AND e.home_id = $1::uuid
  AND ${MAINTENANCE_VISIBLE_PREDICATE_SQL}
LIMIT 2
FOR UPDATE OF e
`;

export const RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL = `
UPDATE maintenance_entries
SET
  status = 'RESOLVED',
  resolved_by_membership_id = $3::uuid,
  resolved_at = $4::timestamptz,
  updated_at = $4::timestamptz
WHERE home_id = $1::uuid
  AND id = $2::uuid
  AND status = 'OPEN'
  AND resolved_by_membership_id IS NULL
  AND resolved_at IS NULL
RETURNING ${MAINTENANCE_ENTRY_COLUMNS}
`;

export const LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL = `
WITH actor_scope AS (
  SELECT memberships.id AS actor_membership_id
  FROM memberships
  INNER JOIN homes
    ON homes.id = memberships.home_id
  WHERE ${MAINTENANCE_ACTOR_SCOPE_SQL}
),
visible_entries AS (
  SELECT
    ${MAINTENANCE_LIST_COLUMNS}
  FROM actor_scope
  INNER JOIN maintenance_entries e
    ON e.home_id = $1::uuid
  WHERE ${MAINTENANCE_VISIBLE_PREDICATE_SQL}
    AND ($3::text IS NULL OR e.status = $3)
    AND (
      $6::uuid IS NULL
      OR (
        ${MAINTENANCE_STATUS_RANK_SQL} > $4
        OR (
          ${MAINTENANCE_STATUS_RANK_SQL} = $4
          AND e.updated_at < $5::timestamptz
        )
        OR (
          ${MAINTENANCE_STATUS_RANK_SQL} = $4
          AND e.updated_at = $5::timestamptz
          AND e.id < $6::uuid
        )
      )
    )
  ORDER BY
    ${MAINTENANCE_STATUS_RANK_SQL} ASC,
    e.updated_at DESC,
    e.id DESC
  LIMIT $7
)
SELECT
  actor_scope.actor_membership_id,
  visible_entries.id,
  visible_entries.title,
  visible_entries.status,
  visible_entries.visibility,
  visible_entries.created_by_membership_id,
  visible_entries.resolved_by_membership_id,
  visible_entries.resolved_at,
  visible_entries.created_at,
  visible_entries.updated_at,
  visible_entries.status_rank
FROM actor_scope
LEFT JOIN visible_entries ON TRUE
`;

export type NewMaintenanceEntry = Readonly<{
  id: string;
  homeId: string;
  createdByMembershipId: string;
  visibility: MaintenanceVisibility;
  title: string;
  details: string | null;
  status: MaintenanceStatus;
  resolvedByMembershipId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type InsertMaintenanceEntryWithAudience = Readonly<{
  entry: NewMaintenanceEntry;
  audienceMembershipIds: readonly string[];
}>;

export type ResolveOpenMaintenanceEntry = Readonly<{
  homeId: string;
  maintenanceEntryId: string;
  resolverMembershipId: string;
  resolvedAt: Date;
}>;

export type ListVisibleMaintenanceEntries = Readonly<{
  homeId: string;
  actorMembershipId: string;
  limit: number;
  cursor?: string;
  status?: MaintenanceStatus;
}>;

export type MaintenanceVisiblePage = Readonly<{
  items: readonly MaintenanceListItemProjection[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

export type MaintenanceRepository = Readonly<{
  insertEntryWithAudience(
    tx: TransactionContext,
    input: InsertMaintenanceEntryWithAudience,
  ): Promise<MaintenanceEntry>;
  findVisibleByHomeAndId(
    homeId: string,
    maintenanceEntryId: string,
    actorMembershipId: string,
  ): Promise<MaintenanceDetailProjection | null>;
  lockVisibleForResolve(
    tx: TransactionContext,
    homeId: string,
    maintenanceEntryId: string,
    actorMembershipId: string,
  ): Promise<MaintenanceDetailProjection | null>;
  listVisibleByHome(
    input: ListVisibleMaintenanceEntries,
  ): Promise<MaintenanceVisiblePage | null>;
  resolveOpenEntry(
    tx: TransactionContext,
    input: ResolveOpenMaintenanceEntry,
  ): Promise<MaintenanceEntry | null>;
}>;

type MaintenanceEntryRow = {
  id: unknown;
  home_id: unknown;
  created_by_membership_id: unknown;
  visibility: unknown;
  title: unknown;
  details: unknown;
  status: unknown;
  resolved_by_membership_id: unknown;
  resolved_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type MaintenanceDetailRow = {
  id: unknown;
  title: unknown;
  details: unknown;
  status: unknown;
  visibility: unknown;
  created_by_membership_id: unknown;
  resolved_by_membership_id: unknown;
  resolved_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type MaintenanceListRow = {
  actor_membership_id: unknown;
  id: unknown;
  title: unknown;
  status: unknown;
  visibility: unknown;
  created_by_membership_id: unknown;
  resolved_by_membership_id: unknown;
  resolved_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  status_rank: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}

function optionalDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new MaintenancePersistenceError();
}

function optionalUuid(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (isUuid(value)) {
    return value;
  }
  throw new MaintenancePersistenceError();
}

function optionalDetails(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw new MaintenancePersistenceError();
}

function parseMaintenanceEntryRow(
  row: MaintenanceEntryRow,
  homeId: string,
): MaintenanceEntry {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    row.home_id !== homeId ||
    !isUuid(row.created_by_membership_id) ||
    !isMaintenanceVisibility(row.visibility) ||
    typeof row.title !== 'string' ||
    row.title.length === 0 ||
    !isMaintenanceStatus(row.status) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at)
  ) {
    throw new MaintenancePersistenceError();
  }

  const details = optionalDetails(row.details);
  const resolvedByMembershipId = optionalUuid(row.resolved_by_membership_id);
  const resolvedAt = optionalDate(row.resolved_at);
  if (
    !isValidMaintenanceLifecycle({
      status: row.status,
      resolvedByMembershipId,
      resolvedAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  ) {
    throw new MaintenancePersistenceError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    createdByMembershipId: row.created_by_membership_id,
    visibility: row.visibility,
    title: row.title,
    details,
    status: row.status,
    resolvedByMembershipId,
    resolvedAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseDetailProjection(
  row: MaintenanceDetailRow,
): MaintenanceDetailProjection {
  if (
    !isUuid(row.id) ||
    typeof row.title !== 'string' ||
    row.title.length === 0 ||
    !isMaintenanceStatus(row.status) ||
    !isMaintenanceVisibility(row.visibility) ||
    !isUuid(row.created_by_membership_id) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at)
  ) {
    throw new MaintenancePersistenceError();
  }

  const details = optionalDetails(row.details);
  const resolvedByMembershipId = optionalUuid(row.resolved_by_membership_id);
  const resolvedAt = optionalDate(row.resolved_at);
  if (
    !isValidMaintenanceLifecycle({
      status: row.status,
      resolvedByMembershipId,
      resolvedAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  ) {
    throw new MaintenancePersistenceError();
  }

  return Object.freeze({
    id: row.id,
    title: row.title,
    details,
    status: row.status,
    visibility: row.visibility,
    createdByMembershipId: row.created_by_membership_id,
    resolvedByMembershipId,
    resolvedAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseListItemProjection(
  row: MaintenanceListRow,
): MaintenanceListItemProjection {
  if (
    !isUuid(row.id) ||
    typeof row.title !== 'string' ||
    row.title.length === 0 ||
    !isMaintenanceStatus(row.status) ||
    !isMaintenanceVisibility(row.visibility) ||
    !isUuid(row.created_by_membership_id) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at)
  ) {
    throw new MaintenancePersistenceError();
  }

  const resolvedByMembershipId = optionalUuid(row.resolved_by_membership_id);
  const resolvedAt = optionalDate(row.resolved_at);
  if (
    !isValidMaintenanceLifecycle({
      status: row.status,
      resolvedByMembershipId,
      resolvedAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }) ||
    row.status_rank !== maintenanceStatusRank(row.status)
  ) {
    throw new MaintenancePersistenceError();
  }

  return Object.freeze({
    id: row.id,
    title: row.title,
    status: row.status,
    visibility: row.visibility,
    createdByMembershipId: row.created_by_membership_id,
    resolvedByMembershipId,
    resolvedAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function oneMaintenanceEntry(
  rows: readonly MaintenanceEntryRow[],
  homeId: string,
): MaintenanceEntry {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new MaintenancePersistenceError();
  }
  return parseMaintenanceEntryRow(rows[0], homeId);
}

function oneOrNullDetail(
  rows: readonly MaintenanceDetailRow[],
): MaintenanceDetailProjection | null {
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new MaintenancePersistenceError();
  }
  return parseDetailProjection(rows[0]);
}

function orderedUniqueMembershipIds(
  membershipIds: readonly string[],
): string[] {
  const unique = new Set<string>();
  for (const membershipId of membershipIds) {
    if (!isUuid(membershipId)) {
      throw new MaintenancePersistenceError();
    }
    unique.add(membershipId);
  }
  return [...unique].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function assertCanonicalAudienceSet(
  visibility: MaintenanceVisibility,
  audienceMembershipIds: readonly string[],
): readonly string[] {
  const ordered = orderedUniqueMembershipIds(audienceMembershipIds);
  if (visibility === 'HOUSEHOLD') {
    if (ordered.length !== 0) {
      throw new MaintenancePersistenceError();
    }
    return ordered;
  }
  if (visibility === 'PRIVATE' && ordered.length === 0) {
    throw new MaintenancePersistenceError();
  }
  return ordered;
}

export function createMaintenanceRepository(pool: Pool): MaintenanceRepository {
  return Object.freeze({
    async insertEntryWithAudience(tx, input) {
      const audienceMembershipIds = assertCanonicalAudienceSet(
        input.entry.visibility,
        input.audienceMembershipIds,
      );
      if (
        !isValidMaintenanceLifecycle({
          status: input.entry.status,
          resolvedByMembershipId: input.entry.resolvedByMembershipId,
          resolvedAt: input.entry.resolvedAt,
          createdAt: input.entry.createdAt,
          updatedAt: input.entry.updatedAt,
        })
      ) {
        throw new MaintenancePersistenceError();
      }
      try {
        const inserted = await tx.query<MaintenanceEntryRow>(
          INSERT_MAINTENANCE_ENTRY_SQL,
          [
            input.entry.id,
            input.entry.homeId,
            input.entry.createdByMembershipId,
            input.entry.visibility,
            input.entry.title,
            input.entry.details,
            input.entry.status,
            input.entry.resolvedByMembershipId,
            input.entry.resolvedAt,
            input.entry.createdAt,
            input.entry.updatedAt,
          ],
        );
        const entry = oneMaintenanceEntry(inserted.rows, input.entry.homeId);
        if (entry.visibility === 'PRIVATE') {
          await tx.query(INSERT_MAINTENANCE_AUDIENCE_SET_SQL, [
            entry.homeId,
            entry.id,
            entry.createdAt,
            audienceMembershipIds,
          ]);
        }
        return entry;
      } catch (error) {
        if (error instanceof MaintenancePersistenceError) {
          throw error;
        }
        throw new MaintenancePersistenceError();
      }
    },

    async findVisibleByHomeAndId(
      homeId,
      maintenanceEntryId,
      actorMembershipId,
    ) {
      try {
        const result = await pool.query<MaintenanceDetailRow>(
          FIND_VISIBLE_MAINTENANCE_ENTRY_SQL,
          [homeId, actorMembershipId, maintenanceEntryId],
        );
        return oneOrNullDetail(result.rows);
      } catch (error) {
        if (error instanceof MaintenancePersistenceError) {
          throw error;
        }
        throw new MaintenancePersistenceError();
      }
    },

    async lockVisibleForResolve(
      tx,
      homeId,
      maintenanceEntryId,
      actorMembershipId,
    ) {
      try {
        const result = await tx.query<MaintenanceDetailRow>(
          LOCK_VISIBLE_MAINTENANCE_ENTRY_FOR_RESOLVE_SQL,
          [homeId, actorMembershipId, maintenanceEntryId],
        );
        return oneOrNullDetail(result.rows);
      } catch (error) {
        if (error instanceof MaintenancePersistenceError) {
          throw error;
        }
        throw new MaintenancePersistenceError();
      }
    },

    async listVisibleByHome(input) {
      const limit = assertMaintenanceListLimit(input.limit);
      const statusFilter = input.status ?? null;
      if (statusFilter !== null && !isMaintenanceStatus(statusFilter)) {
        throw new InvalidMaintenanceRequestError();
      }
      const cursor =
        input.cursor === undefined
          ? null
          : bindMaintenanceListCursor(input.cursor, {
              homeId: input.homeId,
              actorMembershipId: input.actorMembershipId,
              statusFilter,
              queryFingerprint: MAINTENANCE_LIST_QUERY_FINGERPRINT,
            });
      try {
        const result = await pool.query<MaintenanceListRow>(
          LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL,
          [
            input.homeId,
            input.actorMembershipId,
            statusFilter,
            cursor?.statusRank ?? null,
            cursor === null ? null : new Date(cursor.updatedAt),
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
          if (!isUuid(row.actor_membership_id)) {
            throw new MaintenancePersistenceError();
          }
          return parseListItemProjection(row);
        });
        const hasMore = parsed.length > limit;
        const items = Object.freeze(hasMore ? parsed.slice(0, limit) : parsed);
        const last = items[items.length - 1];
        const nextCursor =
          hasMore && last !== undefined
            ? encodeMaintenanceListCursor({
                v: 1,
                statusRank: maintenanceStatusRank(last.status),
                updatedAt: last.updatedAt.toISOString(),
                id: last.id,
                homeId: input.homeId,
                actorMembershipId: input.actorMembershipId,
                statusFilter,
                queryFingerprint: MAINTENANCE_LIST_QUERY_FINGERPRINT,
              })
            : null;
        return Object.freeze({
          items,
          hasMore,
          nextCursor,
        });
      } catch (error) {
        if (
          error instanceof MaintenancePersistenceError ||
          error instanceof InvalidMaintenanceRequestError
        ) {
          throw error;
        }
        throw new MaintenancePersistenceError();
      }
    },

    async resolveOpenEntry(tx, input) {
      try {
        const result = await tx.query<MaintenanceEntryRow>(
          RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL,
          [
            input.homeId,
            input.maintenanceEntryId,
            input.resolverMembershipId,
            input.resolvedAt,
          ],
        );
        if (result.rows.length === 0) {
          return null;
        }
        return oneMaintenanceEntry(result.rows, input.homeId);
      } catch (error) {
        if (error instanceof MaintenancePersistenceError) {
          throw error;
        }
        throw new MaintenancePersistenceError();
      }
    },
  });
}
