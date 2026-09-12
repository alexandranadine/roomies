import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { lockHomeStructure } from '../../domains/homes/lock-home-structure.js';
import { decideInvitationCreate } from '../../domains/invitations/create-policy.js';
import {
  AlreadyHomeMemberError,
  InvitationAlreadyPendingError,
  InvitationPersistenceError,
  InvitationValidityConflictError,
} from '../../domains/invitations/errors.js';
import { INVITATION_LIFETIME_MS } from '../../domains/invitations/invitation.js';
import type {
  InvitationRepository,
  NewInvitation,
} from '../../domains/invitations/repository.js';
import { createInvitationRepository } from '../../domains/invitations/repository.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
  type GeneratedInvitationSecret,
  type InvitationSecret,
} from '../../domains/invitations/secret.js';
import {
  findCanonicalIdentityByEmail,
  type CanonicalIdentity,
} from '../../platform/auth/canonical-identity-by-email.js';
import {
  InvalidNormalizedEmailError,
  normalizeEmail,
  type NormalizedEmail,
} from '../../platform/auth/index.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ForbiddenError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';

export type CreateInvitationInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  email: string;
}>;

export type CreateInvitationResult = Readonly<{
  invitation: Readonly<{
    id: string;
    email: NormalizedEmail;
    expiresAt: Date;
  }>;
  rawSecret: InvitationSecret;
}>;

export type CreateInvitationSecretSource = {
  generate(): GeneratedInvitationSecret;
};

export type CreateInvitationIdentityLookup = (
  tx: TransactionContext,
  email: NormalizedEmail,
) => Promise<CanonicalIdentity | null>;

export type CreateInvitationDependencies = {
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  lockHomeStructure: (
    tx: TransactionContext,
    input: {
      homeId: string;
      actor: Pick<
        ActiveHomeActor,
        'userId' | 'membershipId' | 'homeId' | 'role'
      >;
    },
  ) => Promise<LockedHomeStructure>;
  invitations: Pick<InvitationRepository, 'insert' | 'findEffectivePending'>;
  findCanonicalIdentityByEmail: CreateInvitationIdentityLookup;
  clock: Clock;
  ids: UuidV7Generator;
  invitationLifetimeMs: number;
  secrets: CreateInvitationSecretSource;
};

function logCreateIntegrityFailure(kind: 'exclusion' | 'identity'): void {
  console.error('[invitations] create integrity failure', {
    errorClass: kind,
  });
}

function persistableInvitation(input: NewInvitation): NewInvitation {
  return Object.freeze({
    id: input.id,
    homeId: input.homeId,
    invitedEmail: input.invitedEmail,
    tokenHash: input.tokenHash,
    createdByMembershipId: input.createdByMembershipId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

async function insertReconcilingExclusion(
  deps: CreateInvitationDependencies,
  tx: TransactionContext,
  invitation: NewInvitation,
  at: Date,
): Promise<void> {
  try {
    await tx.query('SAVEPOINT invitation_insert');
  } catch {
    throw new InvitationPersistenceError();
  }

  try {
    await deps.invitations.insert(tx, invitation);
  } catch (error) {
    if (!(error instanceof InvitationValidityConflictError)) {
      throw error;
    }

    try {
      await tx.query('ROLLBACK TO SAVEPOINT invitation_insert');
    } catch {
      throw new InvitationPersistenceError();
    }

    let pending;
    try {
      pending = await deps.invitations.findEffectivePending(tx, {
        homeId: invitation.homeId,
        invitedEmail: invitation.invitedEmail,
        at,
      });
    } catch {
      logCreateIntegrityFailure('exclusion');
      throw new StructuralIntegrityError();
    }

    if (pending !== null) {
      throw new InvitationAlreadyPendingError();
    }

    logCreateIntegrityFailure('exclusion');
    throw new StructuralIntegrityError();
  }
}

export function createCreateInvitation(
  deps: CreateInvitationDependencies,
): (input: CreateInvitationInput) => Promise<CreateInvitationResult> {
  return async (input) => {
    let invitedEmail: NormalizedEmail;
    try {
      invitedEmail = normalizeEmail(input.email);
    } catch (error) {
      if (error instanceof InvalidNormalizedEmailError) {
        throw new InvalidRequestError();
      }
      throw error;
    }

    const invitationId = deps.ids.next();
    const generated = deps.secrets.generate();
    const tokenHash = hashInvitationSecretBytes(generated.bytes);
    const createdAt = deps.clock.now();
    const expiresAt = new Date(createdAt.getTime() + deps.invitationLifetimeMs);

    const committed = await deps.runTransaction(async (tx) => {
      const locked = await deps.lockHomeStructure(tx, {
        homeId: input.homeId,
        actor: input.actor,
      });

      const currentInvariant = evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: locked.activeMemberships,
      });
      if (!currentInvariant.ok) {
        throw new StructuralIntegrityError();
      }

      const authorization = decideInvitationCreate({
        actorRole: locked.actor.role,
      });
      if (!authorization.allowed) {
        throw new ForbiddenError();
      }

      const pending = await deps.invitations.findEffectivePending(tx, {
        homeId: locked.home.id,
        invitedEmail,
        at: createdAt,
      });
      if (pending !== null) {
        throw new InvitationAlreadyPendingError();
      }

      let identity: CanonicalIdentity | null;
      try {
        identity = await deps.findCanonicalIdentityByEmail(tx, invitedEmail);
      } catch {
        logCreateIntegrityFailure('identity');
        throw new StructuralIntegrityError();
      }

      if (
        identity !== null &&
        locked.activeMemberships.some(
          (membership) => membership.userId === identity.userId,
        )
      ) {
        throw new AlreadyHomeMemberError();
      }

      const invitation = persistableInvitation({
        id: invitationId,
        homeId: locked.home.id,
        invitedEmail,
        tokenHash,
        createdByMembershipId: locked.actor.membershipId,
        createdAt,
        expiresAt,
      });
      await insertReconcilingExclusion(deps, tx, invitation, createdAt);
      return true;
    });

    if (committed !== true) {
      throw new StructuralIntegrityError();
    }

    return Object.freeze({
      invitation: Object.freeze({
        id: invitationId,
        email: invitedEmail,
        expiresAt,
      }),
      rawSecret: generated.encoded,
    });
  };
}

export function createCreateInvitationFromPool(
  pool: TransactionPool,
): ReturnType<typeof createCreateInvitation> {
  return createCreateInvitation({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    lockHomeStructure,
    invitations: createInvitationRepository(
      pool as Parameters<typeof createInvitationRepository>[0],
    ),
    findCanonicalIdentityByEmail: (tx, email) =>
      findCanonicalIdentityByEmail(tx, email),
    clock: systemClock,
    ids: systemUuidV7,
    invitationLifetimeMs: INVITATION_LIFETIME_MS,
    secrets: { generate: generateInvitationSecret },
  });
}
