import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import type { NewSupplyEntry } from '../../domains/supplies/repository.js';
import type { SupplyEntry } from '../../domains/supplies/supply.js';
import { SUPPLY_TITLE_MAX_LENGTH } from '../../domains/supplies/supply-title.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createCreateSupplyEntry,
  type CreateSupplyEntryDependencies,
  type CreateSupplyEntryInput,
} from './create-supply-entry.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OLD_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENTRY_A = '018f1e2c-7e3a-7000-8000-1234567890ab';
const ENTRY_B = '018f1e2c-7e3a-7000-8000-1234567890ac';
const OCCURRED_AT = new Date('2026-09-12T18:00:00.000Z');
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
  overrides: Partial<CreateSupplyEntryInput> = {},
): CreateSupplyEntryInput {
  return {
    actor: actor(),
    homeId: HOME,
    title: 'Paper towels',
    ...overrides,
  };
}

function persisted(entry: NewSupplyEntry): SupplyEntry {
  return Object.freeze({ ...entry });
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
  ids?: string[];
};

function harness(options: HarnessOptions = {}) {
  const inserts: NewSupplyEntry[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  let committed = false;
  let idIndex = 0;
  let clockCalls = 0;
  const ids = options.ids ?? [ENTRY_A];

  const deps: CreateSupplyEntryDependencies = {
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
      insertSupplyEntry(_tx, entry) {
        if (options.insertError) {
          return Promise.reject(options.insertError);
        }
        inserts.push(entry);
        return Promise.resolve(persisted(entry));
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
    create: createCreateSupplyEntry(deps),
    inserts,
    lockCalls,
    clockCalls: () => clockCalls,
    isCommitted: () => committed,
  };
}

void describe('createCreateSupplyEntry', () => {
  void it('lets an active Roommate create an OPEN SupplyEntry', async () => {
    const { create, inserts, lockCalls, clockCalls } = harness();
    const created = await create(input());
    assert.equal(created.status, 'OPEN');
    assert.equal(created.title, 'Paper towels');
    assert.equal(created.id, ENTRY_A);
    assert.equal(created.createdByMembershipId, MEMBERSHIP);
    assert.equal(created.obtainedAt, null);
    assert.equal(created.canceledAt, null);
    assert.equal(created.createdAt, OCCURRED_AT);
    assert.equal(created.updatedAt, OCCURRED_AT);
    assert.equal(clockCalls(), 1);
    assert.deepEqual(inserts[0], {
      id: ENTRY_A,
      homeId: HOME,
      title: 'Paper towels',
      status: 'OPEN',
      createdByMembershipId: MEMBERSHIP,
      obtainedAt: null,
      canceledAt: null,
      createdAt: OCCURRED_AT,
      updatedAt: OCCURRED_AT,
    });
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
  });

  void it('lets a Home Admin create through the same content path', async () => {
    const { create, inserts } = harness({
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const created = await create(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(created.title, 'Paper towels');
    assert.equal(created.createdByMembershipId, MEMBERSHIP);
    assert.equal(inserts.length, 1);
  });

  void it('authorizes from the locked Membership role, not the request role', async () => {
    const { create, inserts } = harness({
      memberships: [lockedMembership({ role: 'ROOMMATE' })],
    });
    const created = await create(input({ actor: actor({ role: 'ADMIN' }) }));
    assert.equal(created.title, 'Paper towels');
    assert.equal(inserts.length, 1);
  });

  void it('trims title ends and preserves Unicode and internal whitespace', async () => {
    const { create } = harness();
    const created = await create(input({ title: '  Café 家  towels  ' }));
    assert.equal(created.title, 'Café 家  towels');
  });

  void it('rejects whitespace-only titles before persistence', async () => {
    const { create, inserts, lockCalls } = harness();
    await assert.rejects(
      () => create(input({ title: '   ' })),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.deepEqual(lockCalls, []);
  });

  void it('rejects overlong titles before persistence', async () => {
    const { create, inserts, lockCalls } = harness();
    await assert.rejects(
      () => create(input({ title: 'x'.repeat(SUPPLY_TITLE_MAX_LENGTH + 1) })),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.deepEqual(lockCalls, []);
  });

  void it('rejects a stale or ended actor without inserting', async () => {
    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    const missing = harness({ memberships: [], ids: [ENTRY_B] });

    await assert.rejects(() => ended.create(input()), ConcealedNotFoundError);
    await assert.rejects(() => missing.create(input()), ConcealedNotFoundError);
    assert.equal(ended.isCommitted(), false);
    assert.equal(missing.isCommitted(), false);
    assert.deepEqual(ended.inserts, []);
    assert.deepEqual(missing.inserts, []);
  });

  void it('does not let an old tenure inherit authority after rejoin', async () => {
    const { create, inserts } = harness({
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
        create(
          input({
            actor: actor({ membershipId: OLD_MEMBERSHIP }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
  });

  void it('rejects an actor whose userId no longer matches the locked tenure', async () => {
    const { create, inserts } = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(() => create(input()), ConcealedNotFoundError);
    assert.deepEqual(inserts, []);
  });

  void it('conceals an archived Home observed inside the protected transaction', async () => {
    const { create, inserts } = harness({ homeArchived: true });
    await assert.rejects(() => create(input()), ConcealedNotFoundError);
    assert.deepEqual(inserts, []);
  });

  void it('conceals a Home-scope mismatch without inserting', async () => {
    const { create, inserts, lockCalls } = harness();
    await assert.rejects(
      () => create(input({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
    assert.deepEqual(lockCalls, []);
  });

  void it('allows independent same-title entries with distinct generated IDs', async () => {
    const { create, inserts } = harness({ ids: [ENTRY_A, ENTRY_B] });
    const first = await create(input({ title: 'Same title' }));
    const second = await create(input({ title: 'Same title' }));
    assert.equal(first.id, ENTRY_A);
    assert.equal(second.id, ENTRY_B);
    assert.notEqual(first.id, second.id);
    assert.equal(inserts.length, 2);
  });

  void it('leaves no partial row when insert fails', async () => {
    const { create, isCommitted } = harness({
      insertError: new Error('insert failed'),
    });
    await assert.rejects(() => create(input()), /insert failed/);
    assert.equal(isCommitted(), false);
  });

  void it('leaves no SupplyEntry when protected revalidation fails', async () => {
    const { create, inserts, isCommitted } = harness({
      lockError: new ConcealedNotFoundError(),
    });
    await assert.rejects(() => create(input()), ConcealedNotFoundError);
    assert.equal(isCommitted(), false);
    assert.deepEqual(inserts, []);
  });
});
