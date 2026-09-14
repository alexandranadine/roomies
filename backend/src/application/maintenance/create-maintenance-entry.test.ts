import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExactLockedMembership } from '../../domains/homes/lock-home-and-exact-memberships.js';
import type { MaintenanceEntry } from '../../domains/maintenance/maintenance.js';
import {
  MAINTENANCE_DETAILS_MAX_LENGTH,
  normalizeMaintenanceDetails,
} from '../../domains/maintenance/maintenance-details.js';
import {
  MAINTENANCE_TITLE_MAX_LENGTH,
  normalizeMaintenanceTitle,
} from '../../domains/maintenance/maintenance-title.js';
import { MAINTENANCE_CREATED_V1 } from '../../domains/maintenance/events.js';
import type {
  InsertMaintenanceEntryWithAudience,
  NewMaintenanceEntry,
} from '../../domains/maintenance/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type {
  JsonObject,
  OutboxEventInput,
} from '../../platform/events/outbox-types.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createCreateMaintenanceEntry,
  type CreateMaintenanceEntryDependencies,
  type CreateMaintenanceEntryInput,
} from './create-maintenance-entry.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RECIPIENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_RECIPIENT = '99999999-9999-4999-8999-999999999999';
const OLD_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FOREIGN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ENTRY_A = '018f1e2c-7e3a-7000-8000-1234567890ab';
const ENTRY_B = '018f1e2c-7e3a-7000-8000-1234567890ac';
const EVENT_A = '018f1e2c-7e3a-7000-8000-1234567890ad';
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

function householdInput(
  overrides: Partial<CreateMaintenanceEntryInput> = {},
): CreateMaintenanceEntryInput {
  return {
    actor: actor(),
    homeId: HOME,
    visibility: 'HOUSEHOLD',
    title: 'Leaky faucet',
    ...overrides,
  };
}

function privateInput(
  overrides: Partial<CreateMaintenanceEntryInput> = {},
): CreateMaintenanceEntryInput {
  return {
    actor: actor(),
    homeId: HOME,
    visibility: 'PRIVATE',
    title: 'Broken lock',
    audienceMembershipIds: [],
    ...overrides,
  };
}

function persisted(entry: NewMaintenanceEntry): MaintenanceEntry {
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
  activeMembershipIds?: readonly string[];
  ids?: string[];
};

function harness(options: HarnessOptions = {}) {
  const inserts: InsertMaintenanceEntryWithAudience[] = [];
  const lockCalls: { homeId: string; membershipIds: readonly string[] }[] = [];
  const seamCalls: {
    homeId: string;
    membershipIds: readonly string[];
  }[] = [];
  let committed = false;
  let idIndex = 0;
  let clockCalls = 0;
  let uuidCalls = 0;
  const ids = options.ids ?? [ENTRY_A, EVENT_A];
  const appended: OutboxEventInput<string, JsonObject>[] = [];

  const deps: CreateMaintenanceEntryDependencies = {
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
    findActiveExactMembershipIdsInHome(_tx, lookup) {
      seamCalls.push({
        homeId: lookup.homeId,
        membershipIds: lookup.membershipIds,
      });
      if (options.activeMembershipIds !== undefined) {
        return Promise.resolve(options.activeMembershipIds);
      }
      return Promise.resolve(lookup.membershipIds);
    },
    maintenance: {
      insertEntryWithAudience(_tx, input) {
        if (options.insertError) {
          return Promise.reject(options.insertError);
        }
        inserts.push(input);
        return Promise.resolve(persisted(input.entry));
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
    create: createCreateMaintenanceEntry(deps),
    inserts,
    appended,
    lockCalls,
    seamCalls,
    clockCalls: () => clockCalls,
    uuidCalls: () => uuidCalls,
    isCommitted: () => committed,
  };
}

void describe('createCreateMaintenanceEntry', () => {
  void it('lets an active Roommate create HOUSEHOLD Maintenance', async () => {
    const {
      create,
      inserts,
      appended,
      lockCalls,
      seamCalls,
      clockCalls,
      uuidCalls,
    } = harness();
    const created = await create(householdInput());
    assert.equal(created.id, ENTRY_A);
    assert.equal(created.title, 'Leaky faucet');
    assert.equal(created.details, null);
    assert.equal(created.status, 'OPEN');
    assert.equal(created.visibility, 'HOUSEHOLD');
    assert.equal(created.createdByMembershipId, MEMBERSHIP);
    assert.equal(created.resolvedByMembershipId, null);
    assert.equal(created.resolvedAt, null);
    assert.equal(created.createdAt, OCCURRED_AT);
    assert.equal(created.updatedAt, OCCURRED_AT);
    assert.equal('homeId' in created, false);
    assert.equal('audienceMembershipIds' in created, false);
    assert.equal(clockCalls(), 1);
    assert.equal(uuidCalls(), 2);
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.eventType, MAINTENANCE_CREATED_V1);
    assert.equal(appended[0]?.eventId, EVENT_A);
    assert.equal(appended[0]?.occurredAt, OCCURRED_AT);
    assert.equal(appended[0]?.homeId, HOME);
    assert.deepEqual(appended[0]?.payload, { maintenanceEntryId: ENTRY_A });
    assert.deepEqual(Object.keys(appended[0]?.payload ?? {}), [
      'maintenanceEntryId',
    ]);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
    assert.deepEqual(seamCalls, []);
    assert.deepEqual(inserts[0], {
      entry: {
        id: ENTRY_A,
        homeId: HOME,
        createdByMembershipId: MEMBERSHIP,
        visibility: 'HOUSEHOLD',
        title: 'Leaky faucet',
        details: null,
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: OCCURRED_AT,
        updatedAt: OCCURRED_AT,
      },
      audienceMembershipIds: [],
    });
  });

  void it('lets a Home Admin create through the same HOUSEHOLD path', async () => {
    const { create, inserts } = harness({
      memberships: [lockedMembership({ role: 'ADMIN' })],
    });
    const created = await create(
      householdInput({ actor: actor({ role: 'ADMIN' }) }),
    );
    assert.equal(created.visibility, 'HOUSEHOLD');
    assert.equal(created.createdByMembershipId, MEMBERSHIP);
    assert.equal(inserts.length, 1);
  });

  void it('creates PRIVATE creator-only Maintenance from an empty audience list', async () => {
    const { create, inserts, appended, seamCalls, clockCalls, uuidCalls } =
      harness();
    const created = await create(privateInput());
    assert.equal(created.visibility, 'PRIVATE');
    assert.equal(created.createdByMembershipId, MEMBERSHIP);
    assert.equal('audienceMembershipIds' in created, false);
    assert.equal(clockCalls(), 1);
    assert.equal(uuidCalls(), 2);
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.eventType, MAINTENANCE_CREATED_V1);
    assert.deepEqual(appended[0]?.payload, { maintenanceEntryId: ENTRY_A });
    assert.deepEqual(seamCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
    assert.deepEqual(inserts[0]?.audienceMembershipIds, [MEMBERSHIP]);
  });

  void it('unions the creator, normalizes duplicates, and sorts PRIVATE audience', async () => {
    const { create, inserts, lockCalls, seamCalls } = harness();
    const created = await create(
      privateInput({
        audienceMembershipIds: [
          OTHER_RECIPIENT,
          RECIPIENT,
          MEMBERSHIP,
          RECIPIENT,
        ],
      }),
    );
    assert.equal(created.visibility, 'PRIVATE');
    const expected = [OTHER_RECIPIENT, MEMBERSHIP, RECIPIENT].sort(
      (left, right) => (left < right ? -1 : left > right ? 1 : 0),
    );
    assert.deepEqual(inserts[0]?.audienceMembershipIds, expected);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, membershipIds: [MEMBERSHIP] },
    ]);
    assert.deepEqual(seamCalls, [{ homeId: HOME, membershipIds: expected }]);
    assert.equal(lockCalls[0]?.membershipIds.includes(RECIPIENT), false);
  });

  void it('lets an active Roommate include multiple same-Home recipients', async () => {
    const { create, inserts } = harness();
    await create(
      privateInput({
        audienceMembershipIds: [RECIPIENT, OTHER_RECIPIENT],
      }),
    );
    assert.deepEqual(
      inserts[0]?.audienceMembershipIds,
      [OTHER_RECIPIENT, MEMBERSHIP, RECIPIENT].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });

  void it('reuses frozen title and details normalization', async () => {
    const { create, inserts } = harness();
    const created = await create(
      householdInput({
        title: '  Café 家  leak  ',
        details: '  Please fix soon.  ',
      }),
    );
    assert.equal(created.title, normalizeMaintenanceTitle('  Café 家  leak  '));
    assert.equal(
      created.details,
      normalizeMaintenanceDetails('  Please fix soon.  '),
    );
    assert.equal(inserts[0]?.entry.details, 'Please fix soon.');
  });

  void it('normalizes empty details to null', async () => {
    const { create } = harness();
    const created = await create(householdInput({ details: '   ' }));
    assert.equal(created.details, null);
  });

  void it('authorizes from the locked Membership role, not the request role', async () => {
    const { create, inserts } = harness({
      memberships: [lockedMembership({ role: 'ROOMMATE' })],
    });
    const created = await create(
      householdInput({ actor: actor({ role: 'ADMIN' }) }),
    );
    assert.equal(created.title, 'Leaky faucet');
    assert.equal(inserts.length, 1);
  });

  void it('rejects HOUSEHOLD when the audience property is present as []', async () => {
    const { create, inserts, clockCalls, isCommitted } = harness();
    await assert.rejects(
      () =>
        create({
          actor: actor(),
          homeId: HOME,
          visibility: 'HOUSEHOLD',
          title: 'Leaky faucet',
          audienceMembershipIds: [],
        }),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.equal(clockCalls(), 0);
    assert.equal(isCommitted(), false);
  });

  void it('rejects HOUSEHOLD when the audience property includes the actor', async () => {
    const { create, inserts, clockCalls } = harness();
    await assert.rejects(
      () =>
        create({
          actor: actor(),
          homeId: HOME,
          visibility: 'HOUSEHOLD',
          title: 'Leaky faucet',
          audienceMembershipIds: [MEMBERSHIP],
        }),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.equal(clockCalls(), 0);
  });

  void it('rejects PRIVATE when the audience property is absent', async () => {
    const { create, inserts, clockCalls } = harness();
    await assert.rejects(
      () =>
        create({
          actor: actor(),
          homeId: HOME,
          visibility: 'PRIVATE',
          title: 'Broken lock',
        }),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.equal(clockCalls(), 0);
  });

  void it('rejects an invalid visibility', async () => {
    const { create, inserts, clockCalls } = harness();
    await assert.rejects(
      () => create(householdInput({ visibility: 'SECRET' })),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.equal(clockCalls(), 0);
  });

  void it('rejects invalid title and details without Clock or insert', async () => {
    const blank = harness();
    const overlongTitle = harness();
    const overlongDetails = harness();
    await assert.rejects(
      () => blank.create(householdInput({ title: '   ' })),
      InvalidRequestError,
    );
    await assert.rejects(
      () =>
        overlongTitle.create(
          householdInput({
            title: 'x'.repeat(MAINTENANCE_TITLE_MAX_LENGTH + 1),
          }),
        ),
      InvalidRequestError,
    );
    await assert.rejects(
      () =>
        overlongDetails.create(
          householdInput({
            details: 'x'.repeat(MAINTENANCE_DETAILS_MAX_LENGTH + 1),
          }),
        ),
      InvalidRequestError,
    );
    assert.deepEqual(blank.inserts, []);
    assert.deepEqual(overlongTitle.inserts, []);
    assert.deepEqual(overlongDetails.inserts, []);
    assert.equal(blank.clockCalls(), 0);
    assert.equal(overlongTitle.clockCalls(), 0);
    assert.equal(overlongDetails.clockCalls(), 0);
  });

  void it('rejects a malformed audience Membership UUID as INVALID_REQUEST', async () => {
    const { create, inserts, clockCalls, seamCalls } = harness();
    await assert.rejects(
      () =>
        create(privateInput({ audienceMembershipIds: ['not-a-membership'] })),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
    assert.deepEqual(seamCalls, []);
    assert.equal(clockCalls(), 0);
  });

  void it('conceals a PRIVATE audience mismatch as NOT_FOUND without Clock', async () => {
    const { create, inserts, appended, clockCalls, uuidCalls, isCommitted } =
      harness({
        activeMembershipIds: [MEMBERSHIP],
      });
    await assert.rejects(
      () => create(privateInput({ audienceMembershipIds: [FOREIGN] })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
    assert.deepEqual(appended, []);
    assert.equal(clockCalls(), 0);
    assert.equal(uuidCalls(), 0);
    assert.equal(isCommitted(), false);
  });

  void it('rolls back when one requested recipient is inactive', async () => {
    const { create, inserts, isCommitted } = harness({
      activeMembershipIds: [MEMBERSHIP],
    });
    await assert.rejects(
      () =>
        create(privateInput({ audienceMembershipIds: [RECIPIENT, FOREIGN] })),
      (error: unknown) => {
        assert.ok(error instanceof ConcealedNotFoundError);
        assert.equal(error.message, 'Not found');
        assert.doesNotMatch(error.message, /foreign|ended|missing|Home/i);
        return true;
      },
    );
    assert.deepEqual(inserts, []);
    assert.equal(isCommitted(), false);
  });

  void it('rejects a stale or ended actor without inserting', async () => {
    const ended = harness({
      memberships: [lockedMembership({ endedAt: OCCURRED_AT })],
    });
    const missing = harness({ memberships: [], ids: [ENTRY_B] });

    await assert.rejects(
      () => ended.create(householdInput()),
      ConcealedNotFoundError,
    );
    await assert.rejects(
      () => missing.create(householdInput()),
      ConcealedNotFoundError,
    );
    assert.equal(ended.isCommitted(), false);
    assert.equal(missing.isCommitted(), false);
    assert.deepEqual(ended.inserts, []);
    assert.deepEqual(missing.inserts, []);
    assert.equal(ended.clockCalls(), 0);
    assert.equal(missing.clockCalls(), 0);
  });

  void it('does not let an old tenure inherit create authority after rejoin', async () => {
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
          householdInput({
            actor: actor({ membershipId: OLD_MEMBERSHIP }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
  });

  void it('rejects an actor whose userId no longer matches the locked tenure', async () => {
    const { create, inserts, clockCalls } = harness({
      memberships: [lockedMembership({ userId: OTHER_USER })],
    });
    await assert.rejects(
      () => create(householdInput()),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
    assert.equal(clockCalls(), 0);
  });

  void it('conceals an archived Home observed inside the protected transaction', async () => {
    const { create, inserts, clockCalls } = harness({ homeArchived: true });
    await assert.rejects(
      () => create(householdInput()),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
    assert.equal(clockCalls(), 0);
  });

  void it('conceals a Home-scope mismatch without inserting', async () => {
    const { create, inserts, clockCalls } = harness({
      memberships: [lockedMembership({ homeId: HOME })],
    });
    await assert.rejects(
      () => create(householdInput({ homeId: OTHER_HOME })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
    assert.equal(clockCalls(), 0);
  });

  void it('leaves no partial row when atomic insert fails', async () => {
    const { create, appended, isCommitted, clockCalls, uuidCalls } = harness({
      insertError: new Error('insert failed'),
    });
    await assert.rejects(() => create(householdInput()), /insert failed/);
    assert.equal(isCommitted(), false);
    assert.deepEqual(appended, []);
    assert.equal(clockCalls(), 1);
    assert.equal(uuidCalls(), 1);
  });

  void it('leaves no MaintenanceEntry when protected revalidation fails', async () => {
    const { create, inserts, appended, isCommitted, clockCalls } = harness({
      lockError: new ConcealedNotFoundError(),
    });
    await assert.rejects(
      () => create(householdInput()),
      ConcealedNotFoundError,
    );
    assert.equal(isCommitted(), false);
    assert.deepEqual(inserts, []);
    assert.deepEqual(appended, []);
    assert.equal(clockCalls(), 0);
  });
});
