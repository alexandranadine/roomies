import type { Pool } from 'pg';
import {
  normalizeEmail,
  type NormalizedEmail,
} from '../../platform/auth/index.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  InvitationPersistenceError,
  InvitationValidityConflictError,
} from './errors.js';
import {
  INVITATION_REVOCATION_CAUSES,
  projectInvitationLifecycle,
  type Invitation,
  type InvitationLifecycle,
  type InvitationRevocationCause,
} from './invitation.js';
import { invitationTokenHash, type InvitationTokenHash } from './token-hash.js';

export const INSERT_INVITATION_SQL = `
INSERT INTO invitations (
  id,
  home_id,
  invited_email,
  token_hash,
  created_by_membership_id,
  created_at,
  expires_at
)
VALUES ($1::uuid, $2::uuid, $3::text, $4::bytea, $5::uuid, $6::timestamptz, $7::timestamptz)
`;

const INVITATION_COLUMNS = `
id,
home_id,
invited_email,
token_hash,
created_by_membership_id,
created_at,
expires_at,
accepted_at,
accepted_membership_id,
revoked_at,
revocation_cause
`;

export const FIND_INVITATION_BY_ID_SQL = `
SELECT ${INVITATION_COLUMNS}
FROM invitations
WHERE id = $1::uuid
LIMIT 2
`;

export const FIND_INVITATION_BY_PUBLIC_ID_SQL = `
SELECT ${INVITATION_COLUMNS}
FROM invitations
WHERE id = $1::uuid
  AND home_id = $2::uuid
LIMIT 2
`;

export const LOCK_INVITATION_BY_ID_SQL = `
SELECT ${INVITATION_COLUMNS}
FROM invitations
WHERE id = $1::uuid
  AND home_id = $2::uuid
FOR UPDATE
`;

export const ACCEPT_LOCKED_INVITATION_SQL = `
UPDATE invitations
SET accepted_at = $1::timestamptz,
    accepted_membership_id = $2::uuid
WHERE id = $3::uuid
  AND home_id = $4::uuid
  AND accepted_at IS NULL
  AND accepted_membership_id IS NULL
  AND revoked_at IS NULL
  AND revocation_cause IS NULL
  AND expires_at > $1::timestamptz
`;

export const REVOKE_LOCKED_INVITATION_SQL = `
UPDATE invitations
SET revoked_at = $1::timestamptz,
    revocation_cause = $2::text
WHERE id = $3::uuid
  AND home_id = $4::uuid
  AND accepted_at IS NULL
  AND accepted_membership_id IS NULL
  AND revoked_at IS NULL
  AND revocation_cause IS NULL
  AND expires_at > $1::timestamptz
`;

export const FIND_EFFECTIVE_PENDING_INVITATION_SQL = `
SELECT ${INVITATION_COLUMNS}
FROM invitations
WHERE home_id = $1::uuid
  AND invited_email = $2::text
  AND accepted_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > $3::timestamptz
ORDER BY expires_at, created_at, id
LIMIT 2
`;

export const LOCK_OPEN_INVITATIONS_FOR_HOME_SQL = `
SELECT ${INVITATION_COLUMNS}
FROM invitations
WHERE home_id = $1::uuid
  AND accepted_at IS NULL
  AND revoked_at IS NULL
ORDER BY expires_at, created_at, id
FOR UPDATE
`;

type InvitationRow = {
  id: unknown;
  home_id: unknown;
  invited_email: unknown;
  token_hash: unknown;
  created_by_membership_id: unknown;
  created_at: unknown;
  expires_at: unknown;
  accepted_at: unknown;
  accepted_membership_id: unknown;
  revoked_at: unknown;
  revocation_cause: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDateOrNull(value: unknown): value is Date | null {
  return (
    value === null || (value instanceof Date && !Number.isNaN(value.valueOf()))
  );
}

function isRevocationCause(value: unknown): value is InvitationRevocationCause {
  return (
    typeof value === 'string' &&
    (INVITATION_REVOCATION_CAUSES as readonly string[]).includes(value)
  );
}

function parseEmail(value: unknown): NormalizedEmail {
  if (typeof value !== 'string') {
    throw new InvitationPersistenceError();
  }
  try {
    const normalized = normalizeEmail(value);
    if (normalized !== value) {
      throw new InvitationPersistenceError();
    }
    return normalized;
  } catch {
    throw new InvitationPersistenceError();
  }
}

function parseInvitationRow(row: InvitationRow, homeId: string): Invitation {
  if (
    !isUuid(row.id) ||
    !isUuid(row.home_id) ||
    row.home_id !== homeId ||
    !isUuid(row.created_by_membership_id) ||
    !(row.created_at instanceof Date) ||
    Number.isNaN(row.created_at.valueOf()) ||
    !(row.expires_at instanceof Date) ||
    Number.isNaN(row.expires_at.valueOf()) ||
    !isDateOrNull(row.accepted_at) ||
    !isDateOrNull(row.revoked_at) ||
    !(
      row.accepted_membership_id === null || isUuid(row.accepted_membership_id)
    ) ||
    !(
      row.revocation_cause === null || isRevocationCause(row.revocation_cause)
    ) ||
    !(row.token_hash instanceof Uint8Array)
  ) {
    throw new InvitationPersistenceError();
  }

  try {
    return Object.freeze({
      id: row.id,
      homeId: row.home_id,
      invitedEmail: parseEmail(row.invited_email),
      tokenHash: invitationTokenHash(row.token_hash),
      createdByMembershipId: row.created_by_membership_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      acceptedMembershipId: row.accepted_membership_id,
      revokedAt: row.revoked_at,
      revocationCause: row.revocation_cause,
    });
  } catch {
    throw new InvitationPersistenceError();
  }
}

function hasSqlState(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export type NewInvitation = Readonly<{
  id: string;
  homeId: string;
  invitedEmail: NormalizedEmail;
  tokenHash: InvitationTokenHash;
  createdByMembershipId: string;
  createdAt: Date;
  expiresAt: Date;
}>;

export type LockedOpenInvitation = Readonly<{
  invitation: Invitation;
  lifecycle: Extract<InvitationLifecycle, 'PENDING' | 'EXPIRED'>;
}>;

export type InvitationRepository = Readonly<{
  insert(tx: TransactionContext, invitation: NewInvitation): Promise<void>;
  findById(invitationId: string): Promise<Invitation | null>;
  findByPublicId(
    homeId: string,
    invitationId: string,
  ): Promise<Invitation | null>;
  lockById(
    tx: TransactionContext,
    input: { homeId: string; invitationId: string },
  ): Promise<Invitation | null>;
  acceptLocked(
    tx: TransactionContext,
    input: {
      invitationId: string;
      homeId: string;
      membershipId: string;
      acceptedAt: Date;
    },
  ): Promise<number>;
  revokeLocked(
    tx: TransactionContext,
    input: {
      invitationId: string;
      homeId: string;
      revokedAt: Date;
      cause: InvitationRevocationCause;
    },
  ): Promise<number>;
  findEffectivePending(
    tx: TransactionContext,
    input: { homeId: string; invitedEmail: NormalizedEmail; at: Date },
  ): Promise<Invitation | null>;
  lockOpenForHomeArchive(
    tx: TransactionContext,
    input: { homeId: string; at: Date },
  ): Promise<readonly LockedOpenInvitation[]>;
}>;

export function createInvitationRepository(pool: Pool): InvitationRepository {
  return Object.freeze({
    async insert(tx, invitation) {
      try {
        await tx.query(INSERT_INVITATION_SQL, [
          invitation.id,
          invitation.homeId,
          invitation.invitedEmail,
          Buffer.from(invitation.tokenHash),
          invitation.createdByMembershipId,
          invitation.createdAt,
          invitation.expiresAt,
        ]);
      } catch (error) {
        if (hasSqlState(error, '23P01')) {
          throw new InvitationValidityConflictError();
        }
        throw new InvitationPersistenceError();
      }
    },

    async findById(invitationId) {
      let rows: InvitationRow[];
      try {
        rows = (
          await pool.query<InvitationRow>(FIND_INVITATION_BY_ID_SQL, [
            invitationId,
          ])
        ).rows;
      } catch {
        throw new InvitationPersistenceError();
      }
      if (rows.length === 0) return null;
      if (rows.length !== 1 || rows[0] === undefined) {
        throw new InvitationPersistenceError();
      }
      const homeId = rows[0].home_id;
      if (!isUuid(homeId)) {
        throw new InvitationPersistenceError();
      }
      return parseInvitationRow(rows[0], homeId);
    },

    async findByPublicId(homeId, invitationId) {
      let rows: InvitationRow[];
      try {
        rows = (
          await pool.query<InvitationRow>(FIND_INVITATION_BY_PUBLIC_ID_SQL, [
            invitationId,
            homeId,
          ])
        ).rows;
      } catch {
        throw new InvitationPersistenceError();
      }
      if (rows.length === 0) return null;
      if (rows.length !== 1 || rows[0] === undefined) {
        throw new InvitationPersistenceError();
      }
      return parseInvitationRow(rows[0], homeId);
    },

    async lockById(tx, input) {
      let rows: InvitationRow[];
      try {
        rows = (
          await tx.query<InvitationRow>(LOCK_INVITATION_BY_ID_SQL, [
            input.invitationId,
            input.homeId,
          ])
        ).rows;
      } catch {
        throw new InvitationPersistenceError();
      }
      if (rows.length === 0) return null;
      if (rows.length !== 1 || rows[0] === undefined) {
        throw new InvitationPersistenceError();
      }
      return parseInvitationRow(rows[0], input.homeId);
    },

    async acceptLocked(tx, input) {
      try {
        const result = await tx.query(ACCEPT_LOCKED_INVITATION_SQL, [
          input.acceptedAt,
          input.membershipId,
          input.invitationId,
          input.homeId,
        ]);
        return result.rowCount ?? 0;
      } catch {
        throw new InvitationPersistenceError();
      }
    },

    async revokeLocked(tx, input) {
      try {
        const result = await tx.query(REVOKE_LOCKED_INVITATION_SQL, [
          input.revokedAt,
          input.cause,
          input.invitationId,
          input.homeId,
        ]);
        return result.rowCount ?? 0;
      } catch {
        throw new InvitationPersistenceError();
      }
    },

    async findEffectivePending(tx, input) {
      let rows: InvitationRow[];
      try {
        rows = (
          await tx.query<InvitationRow>(FIND_EFFECTIVE_PENDING_INVITATION_SQL, [
            input.homeId,
            input.invitedEmail,
            input.at,
          ])
        ).rows;
      } catch {
        throw new InvitationPersistenceError();
      }
      if (rows.length === 0) return null;
      if (rows.length !== 1 || rows[0] === undefined) {
        throw new InvitationPersistenceError();
      }
      return parseInvitationRow(rows[0], input.homeId);
    },

    async lockOpenForHomeArchive(tx, input) {
      let rows: InvitationRow[];
      try {
        rows = (
          await tx.query<InvitationRow>(LOCK_OPEN_INVITATIONS_FOR_HOME_SQL, [
            input.homeId,
          ])
        ).rows;
      } catch {
        throw new InvitationPersistenceError();
      }
      return Object.freeze(
        rows.map((row) => {
          const invitation = parseInvitationRow(row, input.homeId);
          const lifecycle = projectInvitationLifecycle(invitation, input.at);
          if (lifecycle !== 'PENDING' && lifecycle !== 'EXPIRED') {
            throw new InvitationPersistenceError();
          }
          return Object.freeze({ invitation, lifecycle });
        }),
      );
    },
  });
}
