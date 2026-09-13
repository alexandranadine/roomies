import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  SupplyClaimNotActiveError,
  SupplyPersistenceError,
} from '../../domains/supplies/errors.js';
import type { ReleaseActiveClaimOwnedByMembership } from '../../domains/supplies/repository.js';
import type {
  SupplyClaim,
  SupplyEntry,
} from '../../domains/supplies/supply.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createReleaseSupplyClaim,
  type ReleaseSupplyClaimDependencies,
  type ReleaseSupplyClaimInput,
} from './release-supply-claim.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
  overrides: Partial<ReleaseSupplyClaimInput> = {},
): ReleaseSupplyClaimInput {
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
    canceledAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
}

function activeClaim(overrides: Partial<SupplyClaim> = {}): SupplyClaim {
  return Object.freeze({
    id: CLAIM,
    homeId: HOME,
    supplyEntryId: ENTRY,
    claimantMembershipId: MEMBERSHIP,
    claimedAt: CREATED_AT,
    releasedAt: null,
    releaseReason: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
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
  releaseError?: Error;
  releaseResult?: SupplyClaim | null;
  transactionError?: Error;
  lockError?: Error;
  homeArchived?: boolean;
  memberships?: readonly ExactLockedMembership[];
  lockedEntry?: SupplyEntry | null;
  lockedClaim?: SupplyClaim | null;
};

function harness(options: HarnessOptions = {}) {
  const releases: ReleaseActiveClaimOwnedByMembership[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  let committed = false;
  let clockCalls = 0;
  const lockedEntry =
    options.lockedEntry === undefined ? openEntry() : options.lockedEntry;
  const lockedClaim =
    options.lockedClaim === undefined ? activeClaim() : options.lockedClaim;

  const deps: ReleaseSupplyClaimDependencies = {
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
      lockSupplyEntryByHomeAndId() {
        return Promise.resolve(lockedEntry);
      },
      lockActiveClaimByEntry() {
        return Promise.resolve(lockedClaim);
      },
      releaseActiveClaimOwnedByMembership(_tx, write) {
        if (options.releaseError) {
          return Promise.reject(options.releaseError);
        }
        releases.push(write);
        if (options.releaseResult === null) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          options.releaseResult ??
            activeClaim({
              releasedAt: write.releasedAt,
              releaseReason: 'CLAIMANT_RELEASED',
              updatedAt: write.releasedAt,
            }),
        );
      },
    },
    clock: {
      now() {
        clockCalls += 1;
        return OCCURRED_AT;
      },
    },
  };

  return {
    release: createReleaseSupplyClaim(deps),
    releases,
    lockCalls,
    clockCalls: () => clockCalls,
    isCommitted: () => committed,
  };
}

void describe('createReleaseSupplyClaim', () => {
  void it('lets the exact claimant release an active claim', async () => {
    const { release, releases, clockCalls } = harness();
    await release(input());
    assert.equal(clockCalls(), 1);
    assert.deepEqual(releases[0], {
      claimId: CLAIM,
      homeId: HOME,
      supplyEntryId: ENTRY,
      claimantMembershipId: MEMBERSHIP,
      releasedAt: OCCURRED_AT,
    });
  });

  void it('conceals a nonclaimant Roommate and a nonclaimant Admin', async () => {
    const roommate = harness({
      lockedClaim: activeClaim({ claimantMembershipId: OTHER_MEMBERSHIP }),
      memberships: [lockedMembership({ role: 'ROOMMATE' })],
    });
    await assert.rejects(
      () => roommate.release(input()),
      ConcealedNotFoundError,
    );
    assert.equal(roommate.clockCalls(), 0);
    assert.deepEqual(roommate.releases, []);

    const admin = harness({
      lockedClaim: activeClaim({ claimantMembershipId: OTHER_MEMBERSHIP }),
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    await assert.rejects(
      () => admin.release(input({ actor: actor({ role: 'ADMIN' }) })),
      ConcealedNotFoundError,
    );
    assert.equal(admin.clockCalls(), 0);
  });

  void it('conceals a creator who is not the claimant', async () => {
    const { release, clockCalls, releases } = harness({
      lockedEntry: openEntry({ createdByMembershipId: MEMBERSHIP }),
      lockedClaim: activeClaim({ claimantMembershipId: OTHER_MEMBERSHIP }),
    });
    await assert.rejects(() => release(input()), ConcealedNotFoundError);
    assert.equal(clockCalls(), 0);
    assert.deepEqual(releases, []);
  });

  void it('conceals a later tenure of the same User', async () => {
    const { release, clockCalls } = harness({
      lockedClaim: activeClaim({ claimantMembershipId: OLD_MEMBERSHIP }),
    });
    await assert.rejects(() => release(input()), ConcealedNotFoundError);
    assert.equal(clockCalls(), 0);
  });

  void it('rejects no active claim and a zero-row conditional update', async () => {
    const missing = harness({ lockedClaim: null });
    await assert.rejects(
      () => missing.release(input()),
      SupplyClaimNotActiveError,
    );
    assert.equal(missing.clockCalls(), 0);

    const raced = harness({ releaseResult: null });
    await assert.rejects(
      () => raced.release(input()),
      SupplyClaimNotActiveError,
    );
    assert.equal(raced.clockCalls(), 1);
  });

  void it('treats a terminal entry with an active claim as persistence failure', async () => {
    const { release, clockCalls, releases } = harness({
      lockedEntry: openEntry({
        status: 'OBTAINED',
        obtainedAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(() => release(input()), SupplyPersistenceError);
    assert.equal(clockCalls(), 0);
    assert.deepEqual(releases, []);
  });

  void it('conceals a missing entry, ended actor, and Home mismatch', async () => {
    const missing = harness({ lockedEntry: null });
    await assert.rejects(
      () => missing.release(input()),
      ConcealedNotFoundError,
    );
    assert.equal(missing.clockCalls(), 0);

    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    await assert.rejects(() => ended.release(input()), ConcealedNotFoundError);

    const user = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(() => user.release(input()), ConcealedNotFoundError);

    const scope = harness();
    await assert.rejects(
      () => scope.release(input({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(scope.lockCalls, []);
    assert.equal(scope.clockCalls(), 0);
  });

  void it('leaves the claim active when the conditional update fails', async () => {
    const { release, isCommitted } = harness({
      releaseError: new Error('update failed'),
    });
    await assert.rejects(() => release(input()), /update failed/);
    assert.equal(isCommitted(), false);
  });
});
