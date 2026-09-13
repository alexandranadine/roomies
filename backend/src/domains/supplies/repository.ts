import type { Pool } from 'pg';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { SupplyAlreadyClaimedError, SupplyPersistenceError } from './errors.js';
import {
  isSupplyClaimReleaseReason,
  isSupplyEntryStatus,
  type ListedSupplyEntry,
  type SupplyClaim,
  type SupplyClaimReleaseReason,
  type SupplyEntry,
  type SupplyEntryStatus,
} from './supply.js';

export const ACTIVE_SUPPLY_CLAIM_UNIQUE_CONSTRAINT =
  'supply_claims_one_active_per_entry_1e26d778';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUPPLY_ENTRY_COLUMNS = `
id,
home_id,
title,
status,
created_by_membership_id,
obtained_at,
canceled_at,
created_at,
updated_at
`;

const SUPPLY_CLAIM_COLUMNS = `
id,
home_id,
supply_entry_id,
claimant_membership_id,
claimed_at,
released_at,
release_reason,
created_at,
updated_at
`;

export const INSERT_SUPPLY_ENTRY_SQL = `
INSERT INTO supply_entries (
  id,
  home_id,
  title,
  status,
  created_by_membership_id,
  obtained_at,
  canceled_at,
  created_at,
  updated_at
)
VALUES (
  $1::uuid,
  $2::uuid,
  $3,
  $4,
  $5::uuid,
  $6::timestamptz,
  $7::timestamptz,
  $8::timestamptz,
  $9::timestamptz
)
RETURNING ${SUPPLY_ENTRY_COLUMNS}
`;

export const INSERT_SUPPLY_CLAIM_SQL = `
INSERT INTO supply_claims (
  id,
  home_id,
  supply_entry_id,
  claimant_membership_id,
  claimed_at,
  released_at,
  release_reason,
  created_at,
  updated_at
)
VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5::timestamptz,
  $6::timestamptz,
  $7,
  $8::timestamptz,
  $9::timestamptz
)
RETURNING ${SUPPLY_CLAIM_COLUMNS}
`;

export const FIND_ACTIVE_CLAIM_BY_ENTRY_SQL = `
SELECT ${SUPPLY_CLAIM_COLUMNS}
FROM supply_claims
WHERE home_id = $1::uuid
  AND supply_entry_id = $2::uuid
  AND released_at IS NULL
LIMIT 2
`;

export const LIST_CLAIMS_FOR_ENTRY_SQL = `
SELECT ${SUPPLY_CLAIM_COLUMNS}
FROM supply_claims
WHERE home_id = $1::uuid
  AND supply_entry_id = $2::uuid
ORDER BY claimed_at ASC, id ASC
`;

const LISTED_SUPPLY_ENTRY_COLUMNS = `
e.id,
e.home_id,
e.title,
e.status,
e.created_by_membership_id,
e.obtained_at,
e.canceled_at,
e.created_at,
e.updated_at,
c.claimant_membership_id AS active_claimant_membership_id,
c.claimed_at AS active_claimed_at
`;

const ACTIVE_CLAIM_LIST_JOIN = `
LEFT JOIN supply_claims c
  ON c.home_id = e.home_id
 AND c.supply_entry_id = e.id
 AND c.released_at IS NULL
`;

export const LIST_OPEN_ENTRIES_BY_HOME_SQL = `
SELECT ${LISTED_SUPPLY_ENTRY_COLUMNS}
FROM supply_entries e
${ACTIVE_CLAIM_LIST_JOIN}
WHERE e.home_id = $1::uuid
  AND e.status = 'OPEN'
ORDER BY e.created_at ASC, e.id ASC
`;

export const LIST_SUPPLY_ENTRIES_BY_HOME_SQL = `
SELECT ${LISTED_SUPPLY_ENTRY_COLUMNS}
FROM supply_entries e
${ACTIVE_CLAIM_LIST_JOIN}
WHERE e.home_id = $1::uuid
ORDER BY
  CASE WHEN e.status = 'OPEN' THEN 0 ELSE 1 END ASC,
  CASE WHEN e.status = 'OPEN' THEN e.created_at END ASC,
  CASE WHEN e.status = 'OPEN' THEN e.id END ASC,
  CASE WHEN e.status <> 'OPEN' THEN e.updated_at END DESC,
  CASE WHEN e.status <> 'OPEN' THEN e.status END ASC,
  CASE WHEN e.status <> 'OPEN' THEN e.id END DESC
`;

export const LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL = `
SELECT ${LISTED_SUPPLY_ENTRY_COLUMNS}
FROM supply_entries e
${ACTIVE_CLAIM_LIST_JOIN}
WHERE e.home_id = $1::uuid
  AND e.status = $2
ORDER BY
  CASE WHEN e.status = 'OPEN' THEN e.created_at END ASC,
  CASE WHEN e.status = 'OPEN' THEN e.id END ASC,
  CASE WHEN e.status <> 'OPEN' THEN e.updated_at END DESC,
  CASE WHEN e.status <> 'OPEN' THEN e.id END DESC
`;

export const LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL = `
SELECT ${SUPPLY_ENTRY_COLUMNS}
FROM supply_entries
WHERE home_id = $1::uuid
  AND id = $2::uuid
LIMIT 2
FOR UPDATE
`;

export const LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL = `
SELECT ${SUPPLY_CLAIM_COLUMNS}
FROM supply_claims
WHERE home_id = $1::uuid
  AND supply_entry_id = $2::uuid
  AND released_at IS NULL
LIMIT 2
FOR UPDATE
`;

export const RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL = `
UPDATE supply_claims
SET
  released_at = $5::timestamptz,
  release_reason = 'CLAIMANT_RELEASED',
  updated_at = $5::timestamptz
WHERE id = $1::uuid
  AND home_id = $2::uuid
  AND supply_entry_id = $3::uuid
  AND claimant_membership_id = $4::uuid
  AND released_at IS NULL
  AND release_reason IS NULL
RETURNING ${SUPPLY_CLAIM_COLUMNS}
`;

/**
 * Terminalization release for an optional active SupplyClaim. Exact claim,
 * Home, and entry only. Never predicates on claimant Membership and never
 * rewrites a historical release reason.
 */
export const RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL = `
UPDATE supply_claims
SET
  released_at = $4::timestamptz,
  release_reason = $5,
  updated_at = $4::timestamptz
WHERE id = $1::uuid
  AND home_id = $2::uuid
  AND supply_entry_id = $3::uuid
  AND released_at IS NULL
  AND release_reason IS NULL
RETURNING ${SUPPLY_CLAIM_COLUMNS}
`;

export const TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL = `
UPDATE supply_entries
SET
  status = 'OBTAINED',
  obtained_at = $3::timestamptz,
  canceled_at = NULL,
  updated_at = $3::timestamptz
WHERE id = $1::uuid
  AND home_id = $2::uuid
  AND status = 'OPEN'
  AND obtained_at IS NULL
  AND canceled_at IS NULL
RETURNING ${SUPPLY_ENTRY_COLUMNS}
`;

export const TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL = `
UPDATE supply_entries
SET
  status = 'CANCELED',
  canceled_at = $3::timestamptz,
  obtained_at = NULL,
  updated_at = $3::timestamptz
WHERE id = $1::uuid
  AND home_id = $2::uuid
  AND status = 'OPEN'
  AND obtained_at IS NULL
  AND canceled_at IS NULL
RETURNING ${SUPPLY_ENTRY_COLUMNS}
`;

/**
 * Membership-ending cleanup for active SupplyClaims. Exact Home + exact
 * Membership tenure only. Already-released rows stay historical. Never
 * rewrites claimant_membership_id or SupplyEntry status.
 */
export const RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL = `
UPDATE supply_claims
SET
  released_at = $3::timestamptz,
  release_reason = 'MEMBERSHIP_ENDED',
  updated_at = $3::timestamptz
WHERE home_id = $1::uuid
  AND claimant_membership_id = $2::uuid
  AND released_at IS NULL
`;

export type NewSupplyEntry = Readonly<{
  id: string;
  homeId: string;
  title: string;
  status: SupplyEntryStatus;
  createdByMembershipId: string;
  obtainedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type NewSupplyClaim = Readonly<{
  id: string;
  homeId: string;
  supplyEntryId: string;
  claimantMembershipId: string;
  claimedAt: Date;
  releasedAt: Date | null;
  releaseReason: SupplyClaimReleaseReason | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ReleaseMembershipClaims = Readonly<{
  homeId: string;
  membershipId: string;
  releasedAt: Date;
}>;

export type ReleaseActiveClaimOwnedByMembership = Readonly<{
  claimId: string;
  homeId: string;
  supplyEntryId: string;
  claimantMembershipId: string;
  releasedAt: Date;
}>;

export type SupplyTerminalClaimReleaseReason = Extract<
  SupplyClaimReleaseReason,
  'ENTRY_OBTAINED' | 'ENTRY_CANCELED'
>;

export type ReleaseActiveClaimForEntryTerminalization = Readonly<{
  claimId: string;
  homeId: string;
  supplyEntryId: string;
  releasedAt: Date;
  reason: SupplyTerminalClaimReleaseReason;
}>;

export type TerminalizeSupplyEntryAsObtained = Readonly<{
  supplyEntryId: string;
  homeId: string;
  obtainedAt: Date;
}>;

export type TerminalizeSupplyEntryAsCanceled = Readonly<{
  supplyEntryId: string;
  homeId: string;
  canceledAt: Date;
}>;

export type SupplyRepository = Readonly<{
  insertSupplyEntry(
    tx: TransactionContext,
    entry: NewSupplyEntry,
  ): Promise<SupplyEntry>;
  insertSupplyClaim(
    tx: TransactionContext,
    claim: NewSupplyClaim,
  ): Promise<SupplyClaim>;
  findActiveClaimByEntry(
    homeId: string,
    supplyEntryId: string,
  ): Promise<SupplyClaim | null>;
  listClaimsForEntry(
    homeId: string,
    supplyEntryId: string,
  ): Promise<readonly SupplyClaim[]>;
  lockSupplyEntryByHomeAndId(
    tx: TransactionContext,
    homeId: string,
    supplyEntryId: string,
  ): Promise<SupplyEntry | null>;
  lockActiveClaimByEntry(
    tx: TransactionContext,
    homeId: string,
    supplyEntryId: string,
  ): Promise<SupplyClaim | null>;
  listOpenEntriesByHome(homeId: string): Promise<readonly ListedSupplyEntry[]>;
  listSupplyEntriesByHome(
    homeId: string,
  ): Promise<readonly ListedSupplyEntry[]>;
  listSupplyEntriesByHomeAndStatus(
    homeId: string,
    status: SupplyEntryStatus,
  ): Promise<readonly ListedSupplyEntry[]>;
  releaseActiveClaimOwnedByMembership(
    tx: TransactionContext,
    input: ReleaseActiveClaimOwnedByMembership,
  ): Promise<SupplyClaim | null>;
  releaseActiveClaimForEntryTerminalization(
    tx: TransactionContext,
    input: ReleaseActiveClaimForEntryTerminalization,
  ): Promise<SupplyClaim | null>;
  terminalizeSupplyEntryAsObtained(
    tx: TransactionContext,
    input: TerminalizeSupplyEntryAsObtained,
  ): Promise<SupplyEntry | null>;
  terminalizeSupplyEntryAsCanceled(
    tx: TransactionContext,
    input: TerminalizeSupplyEntryAsCanceled,
  ): Promise<SupplyEntry | null>;
  releaseActiveClaimsForMembership(
    tx: TransactionContext,
    input: ReleaseMembershipClaims,
  ): Promise<number>;
}>;

type SupplyEntryRow = {
  id: unknown;
  home_id: unknown;
  title: unknown;
  status: unknown;
  created_by_membership_id: unknown;
  obtained_at: unknown;
  canceled_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type SupplyClaimRow = {
  id: unknown;
  home_id: unknown;
  supply_entry_id: unknown;
  claimant_membership_id: unknown;
  claimed_at: unknown;
  released_at: unknown;
  release_reason: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type ListedSupplyEntryRow = SupplyEntryRow & {
  active_claimant_membership_id: unknown;
  active_claimed_at: unknown;
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

function optionalDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (isDate(value)) {
    return value;
  }
  throw new SupplyPersistenceError();
}

function parseSupplyEntryRow(row: SupplyEntryRow, homeId: string): SupplyEntry {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    row.home_id !== homeId ||
    typeof row.title !== 'string' ||
    !isSupplyEntryStatus(row.status) ||
    !isUuid(row.created_by_membership_id) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at)
  ) {
    throw new SupplyPersistenceError();
  }

  const obtainedAt = optionalDate(row.obtained_at);
  const canceledAt = optionalDate(row.canceled_at);
  const validLifecycle =
    (row.status === 'OPEN' && obtainedAt === null && canceledAt === null) ||
    (row.status === 'OBTAINED' && obtainedAt !== null && canceledAt === null) ||
    (row.status === 'CANCELED' && obtainedAt === null && canceledAt !== null);
  if (!validLifecycle) {
    throw new SupplyPersistenceError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    title: row.title,
    status: row.status,
    createdByMembershipId: row.created_by_membership_id,
    obtainedAt,
    canceledAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseSupplyClaimRow(row: SupplyClaimRow, homeId: string): SupplyClaim {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    row.home_id !== homeId ||
    !isUuid(row.supply_entry_id) ||
    !isUuid(row.claimant_membership_id) ||
    !isDate(row.claimed_at) ||
    !isDate(row.created_at) ||
    !isDate(row.updated_at)
  ) {
    throw new SupplyPersistenceError();
  }

  const releasedAt = optionalDate(row.released_at);
  const releaseReason =
    row.release_reason === null
      ? null
      : isSupplyClaimReleaseReason(row.release_reason)
        ? row.release_reason
        : undefined;
  if (
    releaseReason === undefined ||
    (releasedAt === null) !== (releaseReason === null)
  ) {
    throw new SupplyPersistenceError();
  }

  return Object.freeze({
    id: row.id,
    homeId: row.home_id,
    supplyEntryId: row.supply_entry_id,
    claimantMembershipId: row.claimant_membership_id,
    claimedAt: row.claimed_at,
    releasedAt,
    releaseReason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function oneSupplyEntry(
  rows: readonly SupplyEntryRow[],
  homeId: string,
): SupplyEntry {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new SupplyPersistenceError();
  }
  return parseSupplyEntryRow(rows[0], homeId);
}

function oneSupplyClaim(
  rows: readonly SupplyClaimRow[],
  homeId: string,
): SupplyClaim {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new SupplyPersistenceError();
  }
  return parseSupplyClaimRow(rows[0], homeId);
}

function parseListedSupplyEntryRow(
  row: ListedSupplyEntryRow,
  homeId: string,
): ListedSupplyEntry {
  const entry = parseSupplyEntryRow(row, homeId);
  const claimantId = row.active_claimant_membership_id;
  const claimedAt = row.active_claimed_at;
  if (claimantId === null && claimedAt === null) {
    return Object.freeze({
      ...entry,
      activeClaim: null,
    });
  }
  if (!isUuid(claimantId) || !isDate(claimedAt)) {
    throw new SupplyPersistenceError();
  }
  return Object.freeze({
    ...entry,
    activeClaim: Object.freeze({
      claimantMembershipId: claimantId,
      claimedAt,
    }),
  });
}

export function createSupplyRepository(pool: Pool): SupplyRepository {
  return Object.freeze({
    async insertSupplyEntry(tx, entry) {
      try {
        const result = await tx.query<SupplyEntryRow>(INSERT_SUPPLY_ENTRY_SQL, [
          entry.id,
          entry.homeId,
          entry.title,
          entry.status,
          entry.createdByMembershipId,
          entry.obtainedAt,
          entry.canceledAt,
          entry.createdAt,
          entry.updatedAt,
        ]);
        return oneSupplyEntry(result.rows, entry.homeId);
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async insertSupplyClaim(tx, claim) {
      try {
        const result = await tx.query<SupplyClaimRow>(INSERT_SUPPLY_CLAIM_SQL, [
          claim.id,
          claim.homeId,
          claim.supplyEntryId,
          claim.claimantMembershipId,
          claim.claimedAt,
          claim.releasedAt,
          claim.releaseReason,
          claim.createdAt,
          claim.updatedAt,
        ]);
        return oneSupplyClaim(result.rows, claim.homeId);
      } catch (error) {
        if (hasConstraint(error, ACTIVE_SUPPLY_CLAIM_UNIQUE_CONSTRAINT)) {
          throw new SupplyAlreadyClaimedError();
        }
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async findActiveClaimByEntry(homeId, supplyEntryId) {
      try {
        const result = await pool.query<SupplyClaimRow>(
          FIND_ACTIVE_CLAIM_BY_ENTRY_SQL,
          [homeId, supplyEntryId],
        );
        if (result.rows.length === 0) {
          return null;
        }
        return oneSupplyClaim(result.rows, homeId);
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async listClaimsForEntry(homeId, supplyEntryId) {
      try {
        const result = await pool.query<SupplyClaimRow>(
          LIST_CLAIMS_FOR_ENTRY_SQL,
          [homeId, supplyEntryId],
        );
        return Object.freeze(
          result.rows.map((row) => parseSupplyClaimRow(row, homeId)),
        );
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async lockSupplyEntryByHomeAndId(tx, homeId, supplyEntryId) {
      try {
        const result = await tx.query<SupplyEntryRow>(
          LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL,
          [homeId, supplyEntryId],
        );
        if (result.rows.length === 0) {
          return null;
        }
        return oneSupplyEntry(result.rows, homeId);
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async lockActiveClaimByEntry(tx, homeId, supplyEntryId) {
      try {
        const result = await tx.query<SupplyClaimRow>(
          LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL,
          [homeId, supplyEntryId],
        );
        if (result.rows.length === 0) {
          return null;
        }
        return oneSupplyClaim(result.rows, homeId);
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async listOpenEntriesByHome(homeId) {
      try {
        const result = await pool.query<ListedSupplyEntryRow>(
          LIST_OPEN_ENTRIES_BY_HOME_SQL,
          [homeId],
        );
        return Object.freeze(
          result.rows.map((row) => parseListedSupplyEntryRow(row, homeId)),
        );
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async listSupplyEntriesByHome(homeId) {
      try {
        const result = await pool.query<ListedSupplyEntryRow>(
          LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
          [homeId],
        );
        return Object.freeze(
          result.rows.map((row) => parseListedSupplyEntryRow(row, homeId)),
        );
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async listSupplyEntriesByHomeAndStatus(homeId, status) {
      try {
        const result = await pool.query<ListedSupplyEntryRow>(
          LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
          [homeId, status],
        );
        return Object.freeze(
          result.rows.map((row) => parseListedSupplyEntryRow(row, homeId)),
        );
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async releaseActiveClaimOwnedByMembership(tx, input) {
      try {
        const result = await tx.query<SupplyClaimRow>(
          RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
          [
            input.claimId,
            input.homeId,
            input.supplyEntryId,
            input.claimantMembershipId,
            input.releasedAt,
          ],
        );
        if (result.rows.length === 0) {
          return null;
        }
        if (result.rows.length !== 1) {
          throw new SupplyPersistenceError();
        }
        return oneSupplyClaim(result.rows, input.homeId);
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async releaseActiveClaimForEntryTerminalization(tx, input) {
      if (
        input.reason !== 'ENTRY_OBTAINED' &&
        input.reason !== 'ENTRY_CANCELED'
      ) {
        throw new SupplyPersistenceError();
      }
      try {
        const result = await tx.query<SupplyClaimRow>(
          RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
          [
            input.claimId,
            input.homeId,
            input.supplyEntryId,
            input.releasedAt,
            input.reason,
          ],
        );
        if (result.rows.length === 0) {
          return null;
        }
        if (result.rows.length !== 1) {
          throw new SupplyPersistenceError();
        }
        return oneSupplyClaim(result.rows, input.homeId);
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async terminalizeSupplyEntryAsObtained(tx, input) {
      try {
        const result = await tx.query<SupplyEntryRow>(
          TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
          [input.supplyEntryId, input.homeId, input.obtainedAt],
        );
        if (result.rows.length === 0) {
          return null;
        }
        return oneSupplyEntry(result.rows, input.homeId);
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async terminalizeSupplyEntryAsCanceled(tx, input) {
      try {
        const result = await tx.query<SupplyEntryRow>(
          TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
          [input.supplyEntryId, input.homeId, input.canceledAt],
        );
        if (result.rows.length === 0) {
          return null;
        }
        return oneSupplyEntry(result.rows, input.homeId);
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },

    async releaseActiveClaimsForMembership(tx, input) {
      try {
        const result = await tx.query(
          RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
          [input.homeId, input.membershipId, input.releasedAt],
        );
        return result.rowCount ?? 0;
      } catch (error) {
        if (error instanceof SupplyPersistenceError) {
          throw error;
        }
        throw new SupplyPersistenceError();
      }
    },
  });
}
