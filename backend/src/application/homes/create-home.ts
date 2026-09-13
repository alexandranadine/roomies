import type { Home } from '../../domains/homes/home.js';
import {
  InvalidHomeNameError,
  normalizeHomeName,
} from '../../domains/homes/home-name.js';
import { insertHome, type NewHome } from '../../domains/homes/insert-home.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { evaluateHomeStructureInvariant } from '../../domains/homes/structure-invariant.js';
import {
  insertActiveMembership,
  type NewActiveMembership,
} from '../../domains/memberships/insert-active-membership.js';
import { InvalidRequestError } from '../../platform/authz/errors.js';
import type { UuidV7Generator } from '../../platform/ids/uuid-v7.js';
import { systemUuidV7 } from '../../platform/ids/uuid-v7.js';
import {
  runInReadCommittedTransaction,
  type TransactionContext,
  type TransactionPool,
} from '../../platform/persistence/transaction.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';
import {
  canonicalizeIanaTimeZone,
  InvalidIanaTimeZoneError,
} from '../../platform/time/iana-timezone.js';

export type CreateHomeInput = Readonly<{
  userId: string;
  name: string;
  timezone: string;
}>;

export type CreateHomeResult = Readonly<{
  home: Home;
  membership: Readonly<{
    id: string;
    role: 'ADMIN';
  }>;
}>;

export type CreateHomeDependencies = Readonly<{
  runTransaction: <T>(
    work: (tx: TransactionContext) => Promise<T>,
  ) => Promise<T>;
  insertHome: (tx: TransactionContext, home: NewHome) => Promise<void>;
  insertMembership: (
    tx: TransactionContext,
    membership: NewActiveMembership,
  ) => Promise<void>;
  clock: Clock;
  ids: UuidV7Generator;
}>;

function validatedCreateInput(input: CreateHomeInput): {
  name: string;
  timezone: string;
} {
  try {
    return {
      name: normalizeHomeName(input.name),
      timezone: canonicalizeIanaTimeZone(input.timezone),
    };
  } catch (error) {
    if (
      error instanceof InvalidHomeNameError ||
      error instanceof InvalidIanaTimeZoneError
    ) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

/**
 * Atomically creates a Home and the creator's first active ADMIN Membership.
 * Does not write a domain event — no frozen Home-creation or start-cause exists.
 */
export function createCreateHome(
  deps: CreateHomeDependencies,
): (input: CreateHomeInput) => Promise<CreateHomeResult> {
  return async (input) => {
    const { name, timezone } = validatedCreateInput(input);

    return deps.runTransaction(async (tx) => {
      const occurredAt = deps.clock.now();
      const homeId = deps.ids.next();
      const membershipId = deps.ids.next();

      const invariant = evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [{ role: 'ADMIN' }],
      });
      if (!invariant.ok) {
        throw new StructuralIntegrityError();
      }

      await deps.insertHome(tx, {
        id: homeId,
        name,
        timezone,
        createdAt: occurredAt,
      });
      await deps.insertMembership(tx, {
        id: membershipId,
        homeId,
        userId: input.userId,
        role: 'ADMIN',
        joinedAt: occurredAt,
      });

      return Object.freeze({
        home: Object.freeze({
          id: homeId,
          name,
          timezone,
        }),
        membership: Object.freeze({
          id: membershipId,
          role: 'ADMIN' as const,
        }),
      });
    });
  };
}

export function createCreateHomeFromPool(
  pool: TransactionPool,
): ReturnType<typeof createCreateHome> {
  return createCreateHome({
    runTransaction: (work) => runInReadCommittedTransaction(pool, work),
    insertHome,
    insertMembership: insertActiveMembership,
    clock: systemClock,
    ids: systemUuidV7,
  });
}
