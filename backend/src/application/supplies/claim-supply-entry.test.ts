import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  SupplyAlreadyClaimedError,
  SupplyNotOpenError,
} from '../../domains/supplies/errors.js';
import type { NewSupplyClaim } from '../../domains/supplies/repository.js';
import type {
  SupplyClaim,
  SupplyEntry,
} from '../../domains/supplies/supply.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createClaimSupplyEntry,
  type ClaimSupplyEntryDependencies,
  type ClaimSupplyEntryInput,
} from './claim-supply-entry.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OLD_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const CLAIM = '018f1e2c-7e3a-7000-8000-1234567890ad';
const OCCURRED_AT = new Date('2026-09-12T19:00:00.000Z');
const CREATED_AT = new Date('2026-09-12T18:00:00.000Z');
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('unexpected direct query')),
};

function actor(overrides: Partial<ActiveHomeActor> = {}): ActiveHomeActor {
  return {
    userId: USER,
    membershipId: MEMBERSHIP,
    homeId: HOME,
    role: 'ROOMMATE',
    ...overrides,
  };
}

function input(
  overrides: Partial<ClaimSupplyEntryInput> = {},
): ClaimSupplyEntryInput {
  return {
    actor: actor(),
    homeId: HOME,
    supplyEntryId: ENTRY,
    ...overrides,
  };
}

function openEntry(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return Object.freeze({
    id: ENTRY,
    homeId: HOME,
    title: 'Paper towels',
    status: 'OPEN',
    createdByMembershipId: MEMBERSHIP,
    obtainedAt: null,
    obtainedByMembershipId: null,
    canceledAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
}

function persisted(claim: NewSupplyClaim): SupplyClaim {
  return Object.freeze({ ...claim });
}

function lockedMembership(
  overrides: Partial<ExactLockedMembership> = {},
): ExactLockedMembership {
  return {
    id: MEMBERSHIP,
    userId: USER,
    homeId: HOME,
    role: 'ROOMMATE',
    endedAt: null,
    ...overrides,
  };
}

type HarnessOptions = {
  insertError?: Error;
  transactionError?: Error;
  lockError?: Error;
  homeArchived?: boolean;
  memberships?: readonly ExactLockedMembership[];
  lockedEntry?: SupplyEntry | null;
  lockedClaim?: SupplyClaim | null;
  ids?: string[];
};

function harness(options: HarnessOptions = {}) {
  const inserts: NewSupplyClaim[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  const entryLocks: { homeId: string; supplyEntryId: string }[] = [];
  const claimLocks: { homeId: string; supplyEntryId: string }[] = [];
  let committed = false;
  let idIndex = 0;
  let clockCalls = 0;
  const ids = options.ids ?? [CLAIM];
  const lockedEntry =
    options.lockedEntry === undefined ? openEntry() : options.lockedEntry;

  const deps: ClaimSupplyEntryDependencies = {
    runTransaction: async (work) => {
      if (options.transactionError) {
        throw options.transactionError;
      }
      try {
        const result = await work(TX);
        committed = true;
        return result;
      } catch (error) {
        committed = false;
        throw error;
      }
    },
    lockHomeAndExactMemberships(_tx, lookup) {
      lockCalls.push({
        homeId: lookup.homeId,
        membershipIds: lookup.membershipIds,
      });
      if (options.lockError) {
        return Promise.reject(options.lockError);
      }
      return Promise.resolve({
        home: {
          id: lookup.homeId,
          archivedAt: options.homeArchived === true ? OCCURRED_AT : null,
          timezone: 'UTC',
        },
        memberships: options.memberships ?? [lockedMembership()],
      });
    },
    supplies: {
      lockSupplyEntryByHomeAndId(_tx, homeId, supplyEntryId) {
        entryLocks.push({ homeId, supplyEntryId });
        return Promise.resolve(lockedEntry);
      },
      lockActiveClaimByEntry(_tx, homeId, supplyEntryId) {
        claimLocks.push({ homeId, supplyEntryId });
        return Promise.resolve(options.lockedClaim ?? null);
      },
      insertSupplyClaim(_tx, claim) {
        if (options.insertError) {
          return Promise.reject(options.insertError);
        }
        inserts.push(claim);
        return Promise.resolve(persisted(claim));
      },
    },
    clock: {
      now() {
        clockCalls += 1;
        return OCCURRED_AT;
      },
    },
    ids: {
      next() {
        const id = ids[idIndex];
        idIndex += 1;
        if (id === undefined) {
          throw new Error('unexpected extra id');
        }
        return id;
      },
    },
  };

  return {
    claim: createClaimSupplyEntry(deps),
    inserts,
    lockCalls,
    entryLocks,
    claimLocks,
    clockCalls: () => clockCalls,
    idCount: () => idIndex,
    isCommitted: () => committed,
  };
}

void describe('createClaimSupplyEntry', () => {
  void it('lets an active Roommate claim an OPEN SupplyEntry', async () => {
    const { claim, inserts, lockCalls, clockCalls } = harness();
    const created = await claim(input());
    assert.equal(created.id, CLAIM);
    assert.equal(created.supplyEntryId, ENTRY);
    assert.equal(created.claimantMembershipId, MEMBERSHIP);
    assert.equal(created.releasedAt, null);
    assert.equal(created.releaseReason, null);
    assert.equal(created.claimedAt, OCCURRED_AT);
    assert.equal(created.createdAt, OCCURRED_AT);
    assert.equal(created.updatedAt, OCCURRED_AT);
    assert.equal(clockCalls(), 1);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
    assert.deepEqual(inserts[0], {
      id: CLAIM,
      homeId: HOME,
      supplyEntryId: ENTRY,
      claimantMembershipId: MEMBERSHIP,
      claimedAt: OCCURRED_AT,
      releasedAt: null,
      releaseReason: null,
      createdAt: OCCURRED_AT,
      updatedAt: OCCURRED_AT,
    });
  });

  void it('lets a Home Admin claim through ordinary capability', async () => {
    const { claim, inserts } = harness({
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const created = await claim(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(created.claimantMembershipId, MEMBERSHIP);
    assert.equal(inserts.length, 1);
  });

  void it('does not generate a UUID or Clock before auth and state checks', async () => {
    const already = harness({
      lockedClaim: persisted({
        id: CLAIM,
        homeId: HOME,
        supplyEntryId: ENTRY,
        claimantMembershipId: MEMBERSHIP,
        claimedAt: OCCURRED_AT,
        releasedAt: null,
        releaseReason: null,
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(
      () => already.claim(input()),
      SupplyAlreadyClaimedError,
    );
    assert.equal(already.clockCalls(), 0);
    assert.equal(already.idCount(), 0);
    assert.deepEqual(already.inserts, []);

    const closed = harness({
      lockedEntry: openEntry({
        status: 'OBTAINED',
        obtainedAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(() => closed.claim(input()), SupplyNotOpenError);
    assert.equal(closed.clockCalls(), 0);
    assert.equal(closed.idCount(), 0);

    const canceled = harness({
      lockedEntry: openEntry({
        status: 'CANCELED',
        canceledAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(() => canceled.claim(input()), SupplyNotOpenError);

    const sameClaimant = harness({
      lockedClaim: persisted({
        id: CLAIM,
        homeId: HOME,
        supplyEntryId: ENTRY,
        claimantMembershipId: MEMBERSHIP,
        claimedAt: OCCURRED_AT,
        releasedAt: null,
        releaseReason: null,
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(
      () => sameClaimant.claim(input()),
      SupplyAlreadyClaimedError,
    );
  });

  void it('conceals a missing entry, ended actor, and Home mismatch', async () => {
    const missing = harness({ lockedEntry: null });
    await assert.rejects(() => missing.claim(input()), ConcealedNotFoundError);
    assert.equal(missing.clockCalls(), 0);
    assert.equal(missing.idCount(), 0);

    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    await assert.rejects(() => ended.claim(input()), ConcealedNotFoundError);
    assert.equal(ended.clockCalls(), 0);

    const scope = harness();
    await assert.rejects(
      () => scope.claim(input({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(scope.lockCalls, []);
    assert.equal(scope.clockCalls(), 0);
  });

  void it('does not let an old tenure inherit claim authority after rejoin', async () => {
    const { claim, inserts } = harness({
      memberships: [
        lockedMembership({
          id: OLD_MEMBERSHIP,
          endedAt: OCCURRED_AT,
        }),
        lockedMembership({
          id: MEMBERSHIP,
          role: 'ROOMMATE',
        }),
      ],
    });
    await assert.rejects(
      () =>
        claim(
          input({
            actor: actor({ membershipId: OLD_MEMBERSHIP }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
  });

  void it('rejects an actor whose userId no longer matches the locked tenure', async () => {
    const { claim, inserts } = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(() => claim(input()), ConcealedNotFoundError);
    assert.deepEqual(inserts, []);
  });

  void it('leaves no claim when insert fails', async () => {
    const { claim, isCommitted } = harness({
      insertError: new Error('insert failed'),
    });
    await assert.rejects(() => claim(input()), /insert failed/);
    assert.equal(isCommitted(), false);
  });
});
