import {
  normalizeEmail,
  type NormalizedEmail,
} from '../../platform/auth/index.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { InvitationPersistenceError } from './errors.js';
import {
  createInvitationRepository,
  type InvitationRepository,
} from './repository.js';

/**
 * Public invitation cleanup boundary used by future account erasure.
 * Persistence stays in this module. Callers must already hold upstream
 * structural locks and pass that same transaction plus the already-captured
 * canonical email. Does not lock Users, Homes, or Memberships. Does not
 * discover identity rows.
 */
export type EraseInvitationsForTargetEmailInput = Readonly<{
  invitedEmail: NormalizedEmail;
}>;

export type EraseInvitationsForTargetEmail = (
  tx: TransactionContext,
  input: EraseInvitationsForTargetEmailInput,
) => Promise<void>;

/**
 * Require the same already-canonical invited_email representation acceptance
 * and repository parsing use. Does not invent a second normalization path.
 */
function requireCanonicalInvitedEmail(value: NormalizedEmail): NormalizedEmail {
  if (typeof value !== 'string') {
    throw new InvitationPersistenceError();
  }
  try {
    const normalized = normalizeEmail(value);
    if (normalized !== value) {
      throw new InvitationPersistenceError();
    }
    return normalized;
  } catch (error) {
    if (error instanceof InvitationPersistenceError) {
      throw error;
    }
    throw new InvitationPersistenceError();
  }
}

/**
 * Hard-deletes Invitation rows addressed to the exact canonical email,
 * regardless of lifecycle state. Accepted Memberships are untouched.
 * Empty / no-match input is a no-op. No independent transaction is opened.
 */
export function createEraseInvitationsForTargetEmail(
  invitations: Pick<
    InvitationRepository,
    'lockByInvitedEmailForErase' | 'deleteLockedForTargetEmailErase'
  >,
): EraseInvitationsForTargetEmail {
  return async (tx, input) => {
    const invitedEmail = requireCanonicalInvitedEmail(input.invitedEmail);
    const locked = await invitations.lockByInvitedEmailForErase(tx, {
      invitedEmail,
    });
    if (locked.length === 0) {
      return;
    }

    const invitationIds = Object.freeze(locked.map((row) => row.id));
    const deleted = await invitations.deleteLockedForTargetEmailErase(tx, {
      invitationIds,
    });
    if (deleted !== invitationIds.length) {
      throw new InvitationPersistenceError();
    }
  };
}

export function createEraseInvitationsForTargetEmailFromPool(
  pool: Parameters<typeof createInvitationRepository>[0],
): EraseInvitationsForTargetEmail {
  return createEraseInvitationsForTargetEmail(createInvitationRepository(pool));
}
