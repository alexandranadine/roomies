import {
  lockActiveHomeStructureForEntry,
  type LockedHomeEntryStructure,
  StructuralIntegrityError,
} from '../../domains/homes/index.js';
import {
  AlreadyHomeMemberError,
  InvitationEmailMismatchError,
  InvitationEmailNotVerifiedError,
  InvitationNotAvailableError,
} from '../../domains/invitations/errors.js';
import {
  projectInvitationLifecycle,
  type Invitation,
} from '../../domains/invitations/invitation.js';
import {
  createInvitationRepository,
  type InvitationRepository,
} from '../../domains/invitations/repository.js';
import {
  decodeInvitationSecret,
  hashInvitationSecretBytes,
  invitationTokenHashesEqual,
  InvalidInvitationSecretError,
  type InvitationSecret,
} from '../../domains/invitations/secret.js';
import {
  invitationTokenHash,
  type InvitationTokenHash,
} from '../../domains/invitations/token-hash.js';
import {
  ActiveMembershipConflictError,
  createMembershipStartedV1Event,
  findLatestEndedMembershipTenure,
  insertInvitationMembership,
  type NewInvitationMembership,
  type PriorMembershipTenure,
} from '../../domains/memberships/index.js';
import {
  findCurrentCanonicalIdentityByUser,
  type CurrentCanonicalIdentity,
} from '../../platform/auth/index.js';
import { ConcealedNotFoundError } from '../../platform/authz/index.js';
import type { OutboxWriter } from '../../platform/events/outbox-writer.js';
import { outboxWriter } from '../../platform/events/outbox-writer.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';

const UNAVAILABLE_TOKEN_HASH = invitationTokenHash(new Uint8Array(32));

export type AcceptInvitationInput = Readonly<{
  invitationId: string;
  userId: string;
  secret: InvitationSecret;
}>;

export type AcceptInvitationResult = Readonly<{
  membershipId: string;
  homeId: string;
}>;

export type AcceptInvitationDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  invitations: Pick<
    InvitationRepository,
    'findById' | 'lockById' | 'acceptLocked'
  >;
  lockHomeStructure: (
    tx: TransactionContext,
    input: { homeId: string },
  ) => Promise<LockedHomeEntryStructure>;
  findCurrentIdentity: (
    tx: TransactionContext,
    userId: string,
  ) => Promise<CurrentCanonicalIdentity | null>;
  findLatestEndedTenure: (
    tx: TransactionContext,
    input: { homeId: string; userId: string },
  ) => Promise<PriorMembershipTenure | null>;
  insertMembership: (
    tx: TransactionContext,
    membership: NewInvitationMembership,
  ) => Promise<void>;
  outbox: Pick<OutboxWriter, 'append'>;
  clock: Clock;
  ids: UuidV7Generator;
  hashesEqual: (
    left: InvitationTokenHash,
    right: InvitationTokenHash,
  ) => boolean;
}>;

function digestSecret(secret: InvitationSecret): InvitationTokenHash {
  try {
    return hashInvitationSecretBytes(decodeInvitationSecret(secret));
  } catch (error) {
    if (error instanceof InvalidInvitationSecretError) {
      throw new InvitationNotAvailableError();
    }
    throw error;
  }
}

function tokenMatches(
  deps: Pick<AcceptInvitationDependencies, 'hashesEqual'>,
  supplied: InvitationTokenHash,
  invitation: Invitation | null,
): boolean {
  return deps.hashesEqual(
    supplied,
    invitation?.tokenHash ?? UNAVAILABLE_TOKEN_HASH,
  );
}

/**
 * Two-stage acceptance. Stage A only discovers immutable homeId and performs
 * uniform token work. Stage B is authoritative and serializes every structural
 * decision through Home → ordered active Memberships → invitation.
 */
export function createAcceptInvitation(
  deps: AcceptInvitationDependencies,
): (input: AcceptInvitationInput) => Promise<AcceptInvitationResult> {
  return async (input) => {
    const suppliedTokenHash = digestSecret(input.secret);

    // Stage A: non-authoritative preread. No lifecycle or identity decision.
    const preread = await deps.invitations.findById(input.invitationId);
    const prereadTokenMatches = tokenMatches(deps, suppliedTokenHash, preread);
    if (preread === null || !prereadTokenMatches) {
      throw new InvitationNotAvailableError();
    }
    const homeId = preread.homeId;

    return deps.runTransaction(async (tx) => {
      let lockedHome: LockedHomeEntryStructure;
      try {
        lockedHome = await deps.lockHomeStructure(tx, { homeId });
      } catch (error) {
        if (error instanceof ConcealedNotFoundError) {
          throw new InvitationNotAvailableError();
        }
        throw error;
      }

      const invitation = await deps.invitations.lockById(tx, {
        homeId: lockedHome.home.id,
        invitationId: input.invitationId,
      });
      const authoritativeTokenMatches = tokenMatches(
        deps,
        suppliedTokenHash,
        invitation,
      );
      if (invitation === null || !authoritativeTokenMatches) {
        throw new InvitationNotAvailableError();
      }

      const acceptedAt = deps.clock.now();
      if (projectInvitationLifecycle(invitation, acceptedAt) !== 'PENDING') {
        throw new InvitationNotAvailableError();
      }

      const identity = await deps.findCurrentIdentity(tx, input.userId);
      if (identity === null) {
        throw new StructuralIntegrityError();
      }
      if (!identity.emailVerified) {
        throw new InvitationEmailNotVerifiedError();
      }
      if (identity.email !== invitation.invitedEmail) {
        throw new InvitationEmailMismatchError();
      }
      if (lockedHome.home.archived) {
        throw new InvitationNotAvailableError();
      }

      if (
        lockedHome.activeMemberships.some(
          (membership) => membership.userId === input.userId,
        )
      ) {
        throw new AlreadyHomeMemberError();
      }

      const latestEndedTenure = await deps.findLatestEndedTenure(tx, {
        homeId,
        userId: input.userId,
      });
      if (
        latestEndedTenure !== null &&
        invitation.createdAt < latestEndedTenure.endedAt
      ) {
        throw new InvitationNotAvailableError();
      }

      const membershipId = deps.ids.next();
      try {
        await deps.insertMembership(tx, {
          id: membershipId,
          homeId,
          userId: input.userId,
          joinedAt: acceptedAt,
        });
      } catch (error) {
        if (error instanceof ActiveMembershipConflictError) {
          throw new AlreadyHomeMemberError();
        }
        throw error;
      }

      const invitationUpdates = await deps.invitations.acceptLocked(tx, {
        invitationId: invitation.id,
        homeId,
        membershipId,
        acceptedAt,
      });
      if (invitationUpdates !== 1) {
        throw new StructuralIntegrityError();
      }

      await deps.outbox.append(
        tx,
        createMembershipStartedV1Event({
          eventId: deps.ids.next(),
          occurredAt: acceptedAt,
          homeId,
          membershipId,
          invitationId: invitation.id,
        }),
      );

      return Object.freeze({ membershipId, homeId });
    });
  };
}

export function createAcceptInvitationFromPool(
  pool: TransactionPool,
): ReturnType<typeof createAcceptInvitation> {
  return createAcceptInvitation({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    invitations: createInvitationRepository(
      pool as Parameters<typeof createInvitationRepository>[0],
    ),
    lockHomeStructure: lockActiveHomeStructureForEntry,
    findCurrentIdentity: findCurrentCanonicalIdentityByUser,
    findLatestEndedTenure: findLatestEndedMembershipTenure,
    insertMembership: insertInvitationMembership,
    outbox: outboxWriter,
    clock: systemClock,
    ids: systemUuidV7,
    hashesEqual: invitationTokenHashesEqual,
  });
}
