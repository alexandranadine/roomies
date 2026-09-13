import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import {
  MaintenanceNotOpenError,
  MaintenancePersistenceError,
} from '../../domains/maintenance/errors.js';
import type {
  MaintenanceDetailProjection,
  MaintenanceEntry,
} from '../../domains/maintenance/maintenance.js';
import type { ResolveOpenMaintenanceEntry } from '../../domains/maintenance/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createResolveMaintenanceEntry,
  type ResolveMaintenanceEntryDependencies,
  type ResolveMaintenanceEntryInput,
} from './resolve-maintenance-entry.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OLD_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const FOREIGN = '018f1e2c-7e3a-7000-8000-1234567890ff';
const CREATED_AT = new Date('2026-09-13T17:00:00.000Z');
const OCCURRED_AT = new Date('2026-09-13T18:00:00.000Z');
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
  overrides: Partial<ResolveMaintenanceEntryInput> = {},
): ResolveMaintenanceEntryInput {
  return {
    actor: actor(),
    homeId: HOME,
    maintenanceEntryId: ENTRY,
    ...overrides,
  };
}

function openProjection(
  overrides: Partial<MaintenanceDetailProjection> = {},
): MaintenanceDetailProjection {
  return Object.freeze({
    id: ENTRY,
    title: 'Leaky faucet',
    details: 'Kitchen sink',
    status: 'OPEN',
    visibility: 'HOUSEHOLD',
    createdByMembershipId: OTHER_MEMBERSHIP,
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
}

function resolvedEntry(write: ResolveOpenMaintenanceEntry): MaintenanceEntry {
  return Object.freeze({
    id: ENTRY,
    homeId: HOME,
    title: 'Leaky faucet',
    details: 'Kitchen sink',
    status: 'RESOLVED',
    visibility: 'HOUSEHOLD',
    createdByMembershipId: OTHER_MEMBERSHIP,
    resolvedByMembershipId: write.resolverMembershipId,
    resolvedAt: write.resolvedAt,
    createdAt: CREATED_AT,
    updatedAt: write.resolvedAt,
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
  resolveError?: Error;
  resolveResult?: MaintenanceEntry | null;
  transactionError?: Error;
  lockError?: Error;
  homeArchived?: boolean;
  memberships?: readonly ExactLockedMembership[];
  lockedEntry?: MaintenanceDetailProjection | null;
};

function harness(options: HarnessOptions = {}) {
  const writes: ResolveOpenMaintenanceEntry[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  const visibleLocks: {
    homeId: string;
    maintenanceEntryId: string;
    actorMembershipId: string;
  }[] = [];
  let committed = false;
  let clockCalls = 0;
  const lockedEntry =
    options.lockedEntry === undefined ? openProjection() : options.lockedEntry;

  const deps: ResolveMaintenanceEntryDependencies = {
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
    maintenance: {
      lockVisibleForResolve(
        _tx,
        homeId,
        maintenanceEntryId,
        actorMembershipId,
      ) {
        visibleLocks.push({ homeId, maintenanceEntryId, actorMembershipId });
        return Promise.resolve(lockedEntry);
      },
      resolveOpenEntry(_tx, write) {
        if (options.resolveError) {
          return Promise.reject(options.resolveError);
        }
        writes.push(write);
        if (options.resolveResult === null) {
          return Promise.resolve(null);
        }
        return Promise.resolve(options.resolveResult ?? resolvedEntry(write));
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
    resolve: createResolveMaintenanceEntry(deps),
    writes,
    lockCalls,
    visibleLocks,
    clockCalls: () => clockCalls,
    isCommitted: () => committed,
  };
}

void describe('createResolveMaintenanceEntry', () => {
  void it('lets an active Roommate resolve a visible OPEN entry', async () => {
    const { resolve, writes, lockCalls, visibleLocks, clockCalls } = harness();
    const updated = await resolve(input());
    assert.equal(updated.status, 'RESOLVED');
    assert.equal(updated.resolvedByMembershipId, MEMBERSHIP);
    assert.equal(updated.resolvedAt, OCCURRED_AT);
    assert.equal(updated.updatedAt, OCCURRED_AT);
    assert.equal(updated.createdAt, CREATED_AT);
    assert.equal(updated.createdByMembershipId, OTHER_MEMBERSHIP);
    assert.equal(updated.title, 'Leaky faucet');
    assert.equal(updated.details, 'Kitchen sink');
    assert.equal(updated.visibility, 'HOUSEHOLD');
    assert.equal('homeId' in updated, false);
    assert.equal('audienceMembershipIds' in updated, false);
    assert.equal(clockCalls(), 1);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
    assert.deepEqual(visibleLocks, [
      {
        homeId: HOME,
        maintenanceEntryId: ENTRY,
        actorMembershipId: MEMBERSHIP,
      },
    ]);
    assert.deepEqual(writes[0], {
      homeId: HOME,
      maintenanceEntryId: ENTRY,
      resolverMembershipId: MEMBERSHIP,
      resolvedAt: OCCURRED_AT,
    });
  });

  void it('lets a Home Admin resolve through ordinary maintenance.resolve', async () => {
    const { resolve, writes } = harness({
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const updated = await resolve(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(updated.status, 'RESOLVED');
    assert.equal(updated.resolvedByMembershipId, MEMBERSHIP);
    assert.equal(writes.length, 1);
  });

  void it('authorizes from the locked Membership role, not the request role', async () => {
    const { resolve, writes } = harness({
      memberships: [lockedMembership({ role: 'ROOMMATE' })],
    });
    const updated = await resolve(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(updated.status, 'RESOLVED');
    assert.equal(writes[0]?.resolverMembershipId, MEMBERSHIP);
  });

  void it('attributes the exact resolving Membership, not a creator or userId', async () => {
    const { resolve, writes } = harness({
      lockedEntry: openProjection({
        visibility: 'PRIVATE',
        createdByMembershipId: OTHER_MEMBERSHIP,
      }),
    });
    const updated = await resolve(input());
    assert.equal(updated.resolvedByMembershipId, MEMBERSHIP);
    assert.equal(updated.createdByMembershipId, OTHER_MEMBERSHIP);
    assert.equal(writes[0]?.resolverMembershipId, MEMBERSHIP);
  });

  void it('conceals an invisible or missing entry without Clock or write', async () => {
    const missing = harness({ lockedEntry: null });
    await assert.rejects(
      () => missing.resolve(input()),
      ConcealedNotFoundError,
    );
    assert.equal(missing.clockCalls(), 0);
    assert.deepEqual(missing.writes, []);
    assert.equal(missing.visibleLocks.length, 1);

    const foreign = harness({ lockedEntry: null });
    await assert.rejects(
      () => foreign.resolve(input({ maintenanceEntryId: FOREIGN })),
      ConcealedNotFoundError,
    );
    assert.equal(foreign.clockCalls(), 0);
    assert.deepEqual(foreign.writes, []);
  });

  void it('conflicts on a visible already-RESOLVED entry without Clock', async () => {
    const { resolve, writes, clockCalls, isCommitted } = harness({
      lockedEntry: openProjection({
        status: 'RESOLVED',
        resolvedByMembershipId: OTHER_MEMBERSHIP,
        resolvedAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      }),
    });
    await assert.rejects(() => resolve(input()), MaintenanceNotOpenError);
    assert.equal(clockCalls(), 0);
    assert.deepEqual(writes, []);
    assert.equal(isCommitted(), false);
  });

  void it('treats a post-lock zero-row resolve write as persistence failure', async () => {
    const { resolve, isCommitted, clockCalls } = harness({
      resolveResult: null,
    });
    await assert.rejects(() => resolve(input()), MaintenancePersistenceError);
    assert.equal(clockCalls(), 1);
    assert.equal(isCommitted(), false);
  });

  void it('conceals a missing entry, ended actor, and Home mismatch', async () => {
    const missing = harness({ lockedEntry: null });
    await assert.rejects(
      () => missing.resolve(input()),
      ConcealedNotFoundError,
    );
    assert.equal(missing.clockCalls(), 0);

    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    await assert.rejects(() => ended.resolve(input()), ConcealedNotFoundError);
    assert.equal(ended.clockCalls(), 0);
    assert.deepEqual(ended.visibleLocks, []);
    assert.deepEqual(ended.writes, []);

    const scope = harness();
    await assert.rejects(
      () => scope.resolve(input({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.equal(scope.clockCalls(), 0);
    assert.deepEqual(scope.writes, []);
  });

  void it('does not let an old tenure inherit resolve authority after rejoin', async () => {
    const { resolve, writes, visibleLocks, clockCalls } = harness({
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
        resolve(
          input({
            actor: actor({ membershipId: OLD_MEMBERSHIP }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(writes, []);
    assert.deepEqual(visibleLocks, []);
    assert.equal(clockCalls(), 0);
  });

  void it('rejects an actor whose userId no longer matches the locked tenure', async () => {
    const { resolve, writes, clockCalls } = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(() => resolve(input()), ConcealedNotFoundError);
    assert.deepEqual(writes, []);
    assert.equal(clockCalls(), 0);
  });

  void it('conceals an archived Home observed inside the protected transaction', async () => {
    const { resolve, writes, visibleLocks, clockCalls } = harness({
      homeArchived: true,
    });
    await assert.rejects(() => resolve(input()), ConcealedNotFoundError);
    assert.deepEqual(writes, []);
    assert.deepEqual(visibleLocks, []);
    assert.equal(clockCalls(), 0);
  });

  void it('leaves no mutation when the visible lock fails', async () => {
    const { resolve, writes, isCommitted, clockCalls } = harness({
      lockError: new ConcealedNotFoundError(),
    });
    await assert.rejects(() => resolve(input()), ConcealedNotFoundError);
    assert.equal(isCommitted(), false);
    assert.deepEqual(writes, []);
    assert.equal(clockCalls(), 0);
  });

  void it('rolls back when the resolve write fails', async () => {
    const { resolve, isCommitted, clockCalls } = harness({
      resolveError: new Error('resolve failed'),
    });
    await assert.rejects(() => resolve(input()), /resolve failed/);
    assert.equal(isCommitted(), false);
    assert.equal(clockCalls(), 1);
  });
});
