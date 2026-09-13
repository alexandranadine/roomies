import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  SupplyNotOpenError,
  SupplyPersistenceError,
} from '../../domains/supplies/errors.js';
import type {
  ReleaseActiveClaimForEntryTerminalization,
  TerminalizeSupplyEntryAsCanceled,
} from '../../domains/supplies/repository.js';
import type {
  SupplyClaim,
  SupplyEntry,
} from '../../domains/supplies/supply.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createCancelSupplyEntry,
  type CancelSupplyEntryDependencies,
  type CancelSupplyEntryInput,
} from './cancel-supply-entry.js';

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
  overrides: Partial<CancelSupplyEntryInput> = {},
): CancelSupplyEntryInput {
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

function canceledEntry(): SupplyEntry {
  return openEntry({
    status: 'CANCELED',
    canceledAt: OCCURRED_AT,
    updatedAt: OCCURRED_AT,
  });
}

function activeClaim(overrides: Partial<SupplyClaim> = {}): SupplyClaim {
  return Object.freeze({
    id: CLAIM,
    homeId: HOME,
    supplyEntryId: ENTRY,
    claimantMembershipId: OTHER_MEMBERSHIP,
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
  terminalizeError?: Error;
  terminalizeResult?: SupplyEntry | null;
  transactionError?: Error;
  lockError?: Error;
  homeArchived?: boolean;
  memberships?: readonly ExactLockedMembership[];
  lockedEntry?: SupplyEntry | null;
  lockedClaim?: SupplyClaim | null;
};

function harness(options: HarnessOptions = {}) {
  const releases: ReleaseActiveClaimForEntryTerminalization[] = [];
  const terminalizes: TerminalizeSupplyEntryAsCanceled[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  const entryLocks: { homeId: string; supplyEntryId: string }[] = [];
  const claimLocks: { homeId: string; supplyEntryId: string }[] = [];
  let committed = false;
  let clockCalls = 0;
  const lockedEntry =
    options.lockedEntry === undefined ? openEntry() : options.lockedEntry;
  const lockedClaim =
    options.lockedClaim === undefined ? activeClaim() : options.lockedClaim;

  const deps: CancelSupplyEntryDependencies = {
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
        return Promise.resolve(lockedClaim);
      },
      releaseActiveClaimForEntryTerminalization(_tx, write) {
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
              releaseReason: write.reason,
              updatedAt: write.releasedAt,
            }),
        );
      },
      terminalizeSupplyEntryAsCanceled(_tx, write) {
        if (options.terminalizeError) {
          return Promise.reject(options.terminalizeError);
        }
        terminalizes.push(write);
        if (options.terminalizeResult === null) {
          return Promise.resolve(null);
        }
        return Promise.resolve(options.terminalizeResult ?? canceledEntry());
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
    cancel: createCancelSupplyEntry(deps),
    releases,
    terminalizes,
    lockCalls,
    entryLocks,
    claimLocks,
    clockCalls: () => clockCalls,
    isCommitted: () => committed,
  };
}

void describe('createCancelSupplyEntry', () => {
  void it('lets an active Roommate cancel an OPEN entry and release any claim', async () => {
    const { cancel, releases, terminalizes, clockCalls } = harness();
    const updated = await cancel(input());
    assert.equal(updated.status, 'CANCELED');
    assert.equal(updated.canceledAt, OCCURRED_AT);
    assert.equal(updated.obtainedAt, null);
    assert.equal(clockCalls(), 1);
    assert.deepEqual(releases[0], {
      claimId: CLAIM,
      homeId: HOME,
      supplyEntryId: ENTRY,
      releasedAt: OCCURRED_AT,
      reason: 'ENTRY_CANCELED',
    });
    assert.deepEqual(terminalizes[0], {
      supplyEntryId: ENTRY,
      homeId: HOME,
      canceledAt: OCCURRED_AT,
    });
  });

  void it('lets a Home Admin cancel through ordinary capability', async () => {
    const { cancel, terminalizes } = harness({
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const updated = await cancel(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(updated.status, 'CANCELED');
    assert.equal(terminalizes.length, 1);
  });

  void it('lets a noncreator and a nonclaimant cancel equivalently', async () => {
    const { cancel, releases } = harness({
      lockedEntry: openEntry({ createdByMembershipId: OTHER_MEMBERSHIP }),
      lockedClaim: activeClaim({ claimantMembershipId: OTHER_MEMBERSHIP }),
    });
    const updated = await cancel(input());
    assert.equal(updated.status, 'CANCELED');
    assert.equal(releases[0]?.reason, 'ENTRY_CANCELED');
  });

  void it('succeeds when there is no active claim', async () => {
    const { cancel, releases, claimLocks, clockCalls } = harness({
      lockedClaim: null,
    });
    const updated = await cancel(input());
    assert.equal(updated.status, 'CANCELED');
    assert.deepEqual(releases, []);
    assert.equal(claimLocks.length, 1);
    assert.equal(clockCalls(), 1);
  });

  void it('does not call Clock or mutate before OPEN and auth checks', async () => {
    const canceled = harness({
      lockedEntry: openEntry({
        status: 'CANCELED',
        canceledAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(() => canceled.cancel(input()), SupplyNotOpenError);
    assert.equal(canceled.clockCalls(), 0);
    assert.deepEqual(canceled.releases, []);
    assert.deepEqual(canceled.terminalizes, []);
    assert.deepEqual(canceled.claimLocks, []);

    const obtained = harness({
      lockedEntry: openEntry({
        status: 'OBTAINED',
        obtainedAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(() => obtained.cancel(input()), SupplyNotOpenError);
    assert.equal(obtained.clockCalls(), 0);
    assert.deepEqual(obtained.claimLocks, []);
  });

  void it('treats a locked-claim zero-row release as persistence failure', async () => {
    const { cancel, isCommitted, clockCalls, terminalizes } = harness({
      releaseResult: null,
    });
    await assert.rejects(() => cancel(input()), SupplyPersistenceError);
    assert.equal(clockCalls(), 1);
    assert.deepEqual(terminalizes, []);
    assert.equal(isCommitted(), false);
  });

  void it('treats a zero-row entry terminalization as persistence failure', async () => {
    const { cancel, isCommitted } = harness({ terminalizeResult: null });
    await assert.rejects(() => cancel(input()), SupplyPersistenceError);
    assert.equal(isCommitted(), false);
  });

  void it('conceals a missing entry, ended actor, and Home mismatch', async () => {
    const missing = harness({ lockedEntry: null });
    await assert.rejects(() => missing.cancel(input()), ConcealedNotFoundError);
    assert.equal(missing.clockCalls(), 0);
    assert.deepEqual(missing.claimLocks, []);

    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    await assert.rejects(() => ended.cancel(input()), ConcealedNotFoundError);
    assert.equal(ended.clockCalls(), 0);
    assert.deepEqual(ended.entryLocks, []);

    const scope = harness();
    await assert.rejects(
      () => scope.cancel(input({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(scope.lockCalls, []);
    assert.equal(scope.clockCalls(), 0);
  });

  void it('does not let an old tenure inherit cancel authority after rejoin', async () => {
    const { cancel, terminalizes } = harness({
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
        cancel(
          input({
            actor: actor({ membershipId: OLD_MEMBERSHIP }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(terminalizes, []);
  });

  void it('rejects an actor whose userId no longer matches the locked tenure', async () => {
    const { cancel, terminalizes } = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(() => cancel(input()), ConcealedNotFoundError);
    assert.deepEqual(terminalizes, []);
  });

  void it('rolls back when claim release fails', async () => {
    const { cancel, isCommitted } = harness({
      releaseError: new Error('release failed'),
    });
    await assert.rejects(() => cancel(input()), /release failed/);
    assert.equal(isCommitted(), false);
  });
});
