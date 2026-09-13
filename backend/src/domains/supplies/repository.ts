import type { Pool } from 'pg';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { SupplyPersistenceError } from './errors.js';
import {
  isSupplyClaimReleaseReason,
  isSupplyEntryStatus,
  type SupplyClaim,
  type SupplyClaimReleaseReason,
  type SupplyEntry,
  type SupplyEntryStatus,
} from './supply.js';

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

export const LIST_OPEN_ENTRIES_BY_HOME_SQL = `
SELECT ${SUPPLY_ENTRY_COLUMNS}
FROM supply_entries
WHERE home_id = $1::uuid
  AND status = 'OPEN'
ORDER BY created_at ASC, id ASC
`;

export const LIST_SUPPLY_ENTRIES_BY_HOME_SQL = `
SELECT ${SUPPLY_ENTRY_COLUMNS}
FROM supply_entries
WHERE home_id = $1::uuid
ORDER BY
  CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END ASC,
  CASE WHEN status = 'OPEN' THEN created_at END ASC,
  CASE WHEN status = 'OPEN' THEN id END ASC,
  CASE WHEN status <> 'OPEN' THEN updated_at END DESC,
  CASE WHEN status <> 'OPEN' THEN status END ASC,
  CASE WHEN status <> 'OPEN' THEN id END DESC
`;

export const LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL = `
SELECT ${SUPPLY_ENTRY_COLUMNS}
FROM supply_entries
WHERE home_id = $1::uuid
  AND status = $2
ORDER BY
  CASE WHEN status = 'OPEN' THEN created_at END ASC,
  CASE WHEN status = 'OPEN' THEN id END ASC,
  CASE WHEN status <> 'OPEN' THEN updated_at END DESC,
  CASE WHEN status <> 'OPEN' THEN id END DESC
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
  listOpenEntriesByHome(homeId: string): Promise<readonly SupplyEntry[]>;
  listSupplyEntriesByHome(homeId: string): Promise<readonly SupplyEntry[]>;
  listSupplyEntriesByHomeAndStatus(
    homeId: string,
    status: SupplyEntryStatus,
  ): Promise<readonly SupplyEntry[]>;
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

    async listOpenEntriesByHome(homeId) {
      try {
        const result = await pool.query<SupplyEntryRow>(
          LIST_OPEN_ENTRIES_BY_HOME_SQL,
          [homeId],
        );
        return Object.freeze(
          result.rows.map((row) => parseSupplyEntryRow(row, homeId)),
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
        const result = await pool.query<SupplyEntryRow>(
          LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
          [homeId],
        );
        return Object.freeze(
          result.rows.map((row) => parseSupplyEntryRow(row, homeId)),
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
        const result = await pool.query<SupplyEntryRow>(
          LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
          [homeId, status],
        );
        return Object.freeze(
          result.rows.map((row) => parseSupplyEntryRow(row, homeId)),
        );
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
