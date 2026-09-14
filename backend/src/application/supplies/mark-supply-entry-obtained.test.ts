import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  SupplyNotOpenError,
  SupplyPersistenceError,
} from '../../domains/supplies/errors.js';
import { SUPPLY_OBTAINED_V1 } from '../../domains/supplies/events.js';
import type {
  ReleaseActiveClaimForEntryTerminalization,
  TerminalizeSupplyEntryAsObtained,
} from '../../domains/supplies/repository.js';
import type {
  SupplyClaim,
  SupplyEntry,
} from '../../domains/supplies/supply.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type {
  JsonObject,
  OutboxEventInput,
} from '../../platform/events/outbox-types.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createMarkSupplyEntryObtained,
  type MarkSupplyEntryObtainedDependencies,
  type MarkSupplyEntryObtainedInput,
} from './mark-supply-entry-obtained.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OLD_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const CLAIM = '018f1e2c-7e3a-7000-8000-1234567890ad';
const EVENT = '018f1e2c-7e3a-7000-8000-1234567890ae';
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
  overrides: Partial<MarkSupplyEntryObtainedInput> = {},
): MarkSupplyEntryObtainedInput {
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

function obtainedEntry(): SupplyEntry {
  return openEntry({
    status: 'OBTAINED',
    obtainedAt: OCCURRED_AT,
    obtainedByMembershipId: MEMBERSHIP,
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
  const terminalizes: TerminalizeSupplyEntryAsObtained[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  const entryLocks: { homeId: string; supplyEntryId: string }[] = [];
  const claimLocks: { homeId: string; supplyEntryId: string }[] = [];
  const appended: OutboxEventInput<string, JsonObject>[] = [];
  let committed = false;
  let clockCalls = 0;
  let uuidCalls = 0;
  const lockedEntry =
    options.lockedEntry === undefined ? openEntry() : options.lockedEntry;
  const lockedClaim =
    options.lockedClaim === undefined ? activeClaim() : options.lockedClaim;

  const deps: MarkSupplyEntryObtainedDependencies = {
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
      terminalizeSupplyEntryAsObtained(_tx, write) {
        if (options.terminalizeError) {
          return Promise.reject(options.terminalizeError);
        }
        terminalizes.push(write);
        if (options.terminalizeResult === null) {
          return Promise.resolve(null);
        }
        return Promise.resolve(options.terminalizeResult ?? obtainedEntry());
      },
    },
    outbox: {
      append(_tx, event) {
        appended.push(event);
        return Promise.resolve();
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
        uuidCalls += 1;
        return EVENT;
      },
    },
  };

  return {
    obtain: createMarkSupplyEntryObtained(deps),
    releases,
    terminalizes,
    appended,
    lockCalls,
    entryLocks,
    claimLocks,
    clockCalls: () => clockCalls,
    uuidCalls: () => uuidCalls,
    isCommitted: () => committed,
  };
}

void describe('createMarkSupplyEntryObtained', () => {
  void it('lets an active Roommate obtain an OPEN entry and release any claim', async () => {
    const { obtain, releases, terminalizes, appended, clockCalls, uuidCalls } =
      harness();
    const updated = await obtain(input());
    assert.equal(updated.status, 'OBTAINED');
    assert.equal(updated.obtainedAt, OCCURRED_AT);
    assert.equal(updated.obtainedByMembershipId, MEMBERSHIP);
    assert.equal(updated.canceledAt, null);
    assert.equal(clockCalls(), 1);
    assert.equal(uuidCalls(), 1);
    assert.deepEqual(releases[0], {
      claimId: CLAIM,
      homeId: HOME,
      supplyEntryId: ENTRY,
      releasedAt: OCCURRED_AT,
      reason: 'ENTRY_OBTAINED',
    });
    assert.deepEqual(terminalizes[0], {
      supplyEntryId: ENTRY,
      homeId: HOME,
      obtainedAt: OCCURRED_AT,
      obtainedByMembershipId: MEMBERSHIP,
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.eventType, SUPPLY_OBTAINED_V1);
    assert.equal(appended[0]?.eventId, EVENT);
    assert.equal(appended[0]?.occurredAt, OCCURRED_AT);
    assert.equal(appended[0]?.homeId, HOME);
    assert.deepEqual(appended[0]?.payload, { supplyEntryId: ENTRY });
    assert.deepEqual(Object.keys(appended[0]?.payload ?? {}), [
      'supplyEntryId',
    ]);
    assert.equal('title' in (appended[0]?.payload ?? {}), false);
    assert.equal('userId' in (appended[0]?.payload ?? {}), false);
    assert.equal(
      'obtainedByMembershipId' in (appended[0]?.payload ?? {}),
      false,
    );
    assert.equal('claimantMembershipId' in (appended[0]?.payload ?? {}), false);
    assert.equal(
      'createdByMembershipId' in (appended[0]?.payload ?? {}),
      false,
    );
  });

  void it('lets a Home Admin obtain through ordinary capability', async () => {
    const { obtain, terminalizes } = harness({
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const updated = await obtain(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(updated.status, 'OBTAINED');
    assert.equal(terminalizes.length, 1);
  });

  void it('lets a noncreator and a nonclaimant obtain equivalently', async () => {
    const { obtain, releases, appended } = harness({
      lockedEntry: openEntry({ createdByMembershipId: OTHER_MEMBERSHIP }),
      lockedClaim: activeClaim({ claimantMembershipId: OTHER_MEMBERSHIP }),
    });
    const updated = await obtain(input());
    assert.equal(updated.status, 'OBTAINED');
    assert.equal(updated.obtainedByMembershipId, MEMBERSHIP);
    assert.notEqual(updated.obtainedByMembershipId, OTHER_MEMBERSHIP);
    assert.equal(releases[0]?.reason, 'ENTRY_OBTAINED');
    assert.equal(appended.length, 1);
    assert.deepEqual(appended[0]?.payload, { supplyEntryId: ENTRY });
  });

  void it('succeeds when there is no active claim', async () => {
    const { obtain, releases, appended, claimLocks, clockCalls, uuidCalls } =
      harness({
        lockedClaim: null,
      });
    const updated = await obtain(input());
    assert.equal(updated.status, 'OBTAINED');
    assert.deepEqual(releases, []);
    assert.equal(claimLocks.length, 1);
    assert.equal(clockCalls(), 1);
    assert.equal(uuidCalls(), 1);
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.eventType, SUPPLY_OBTAINED_V1);
  });

  void it('does not call Clock or mutate before OPEN and auth checks', async () => {
    const obtained = harness({
      lockedEntry: openEntry({
        status: 'OBTAINED',
        obtainedAt: OCCURRED_AT,
        obtainedByMembershipId: MEMBERSHIP,
      }),
    });
    await assert.rejects(() => obtained.obtain(input()), SupplyNotOpenError);
    assert.equal(obtained.clockCalls(), 0);
    assert.equal(obtained.uuidCalls(), 0);
    assert.deepEqual(obtained.releases, []);
    assert.deepEqual(obtained.terminalizes, []);
    assert.deepEqual(obtained.appended, []);
    assert.deepEqual(obtained.claimLocks, []);

    const canceled = harness({
      lockedEntry: openEntry({
        status: 'CANCELED',
        canceledAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(() => canceled.obtain(input()), SupplyNotOpenError);
    assert.equal(canceled.clockCalls(), 0);
    assert.deepEqual(canceled.claimLocks, []);
  });

  void it('treats a locked-claim zero-row release as persistence failure', async () => {
    const {
      obtain,
      isCommitted,
      clockCalls,
      uuidCalls,
      terminalizes,
      appended,
    } = harness({
      releaseResult: null,
    });
    await assert.rejects(() => obtain(input()), SupplyPersistenceError);
    assert.equal(clockCalls(), 1);
    assert.equal(uuidCalls(), 0);
    assert.deepEqual(terminalizes, []);
    assert.deepEqual(appended, []);
    assert.equal(isCommitted(), false);
  });

  void it('treats a zero-row entry terminalization as persistence failure', async () => {
    const { obtain, appended, uuidCalls, isCommitted } = harness({
      terminalizeResult: null,
    });
    await assert.rejects(() => obtain(input()), SupplyPersistenceError);
    assert.deepEqual(appended, []);
    assert.equal(uuidCalls(), 0);
    assert.equal(isCommitted(), false);
  });

  void it('conceals a missing entry, ended actor, and Home mismatch', async () => {
    const missing = harness({ lockedEntry: null });
    await assert.rejects(() => missing.obtain(input()), ConcealedNotFoundError);
    assert.equal(missing.clockCalls(), 0);
    assert.deepEqual(missing.claimLocks, []);
    assert.deepEqual(missing.appended, []);

    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    await assert.rejects(() => ended.obtain(input()), ConcealedNotFoundError);
    assert.equal(ended.clockCalls(), 0);
    assert.deepEqual(ended.entryLocks, []);

    const scope = harness();
    await assert.rejects(
      () => scope.obtain(input({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(scope.lockCalls, []);
    assert.equal(scope.clockCalls(), 0);
  });

  void it('does not let an old tenure inherit obtain authority after rejoin', async () => {
    const { obtain, terminalizes, appended } = harness({
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
        obtain(
          input({
            actor: actor({ membershipId: OLD_MEMBERSHIP }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(terminalizes, []);
    assert.deepEqual(appended, []);
  });

  void it('rejects an actor whose userId no longer matches the locked tenure', async () => {
    const { obtain, terminalizes, appended } = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(() => obtain(input()), ConcealedNotFoundError);
    assert.deepEqual(terminalizes, []);
    assert.deepEqual(appended, []);
  });

  void it('rolls back when claim release fails', async () => {
    const { obtain, appended, uuidCalls, isCommitted } = harness({
      releaseError: new Error('release failed'),
    });
    await assert.rejects(() => obtain(input()), /release failed/);
    assert.deepEqual(appended, []);
    assert.equal(uuidCalls(), 0);
    assert.equal(isCommitted(), false);
  });
});
