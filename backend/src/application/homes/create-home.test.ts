import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NewHome } from '../../domains/homes/insert-home.js';
import type { NewActiveMembership } from '../../domains/memberships/insert-active-membership.js';
import { InvalidRequestError } from '../../platform/authz/errors.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createCreateHome,
  type CreateHomeDependencies,
} from './create-home.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';
const OCCURRED_AT = new Date('2026-09-12T18:00:00.000Z');
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('unexpected direct query')),
};

type HarnessOptions = {
  membershipError?: Error;
  homeError?: Error;
};

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const homes: NewHome[] = [];
  const memberships: NewActiveMembership[] = [];
  let committed = false;
  let clockCalls = 0;
  let idIndex = 0;
  const ids = [HOME_ID, MEMBERSHIP_ID];

  const deps: CreateHomeDependencies = {
    runTransaction: async (work) => {
      order.push('begin');
      try {
        const result = await work(TX);
        committed = true;
        order.push('commit');
        return result;
      } catch (error) {
        order.push('rollback');
        throw error;
      }
    },
    insertHome: (_tx, home) => {
      order.push('home-insert');
      if (options.homeError) {
        return Promise.reject(options.homeError);
      }
      homes.push(home);
      return Promise.resolve();
    },
    insertMembership: (_tx, membership) => {
      order.push('membership-insert');
      if (options.membershipError) {
        return Promise.reject(options.membershipError);
      }
      memberships.push(membership);
      return Promise.resolve();
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
    order,
    homes,
    memberships,
    get committed() {
      return committed;
    },
    get clockCalls() {
      return clockCalls;
    },
    create: createCreateHome(deps),
  };
}

void describe('createCreateHome', () => {
  void it('creates a Home and founding ADMIN Membership from the canonical User', async () => {
    const run = harness();
    const result = await run.create({
      userId: USER_ID,
      name: '  Oak Street  ',
      timezone: 'America/Los_Angeles',
    });

    assert.equal(run.committed, true);
    assert.equal(run.clockCalls, 1);
    assert.deepEqual(run.order, [
      'begin',
      'home-insert',
      'membership-insert',
      'commit',
    ]);
    assert.match(result.home.id, UUID_V7);
    assert.match(result.membership.id, UUID_V7);
    assert.equal(result.home.id, HOME_ID);
    assert.equal(result.membership.id, MEMBERSHIP_ID);
    assert.equal(result.home.name, 'Oak Street');
    assert.equal(result.home.timezone, 'America/Los_Angeles');
    assert.equal(result.membership.role, 'ADMIN');
    assert.deepEqual(run.homes, [
      {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        createdAt: OCCURRED_AT,
      },
    ]);
    assert.deepEqual(run.memberships, [
      {
        id: MEMBERSHIP_ID,
        homeId: HOME_ID,
        userId: USER_ID,
        role: 'ADMIN',
        joinedAt: OCCURRED_AT,
      },
    ]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('owner'), false);
    assert.equal(serialized.includes('founder'), false);
    assert.equal(serialized.includes('primaryAdmin'), false);
    assert.equal(serialized.includes('createdBy'), false);
  });

  void it('allows a second Home for the same User', async () => {
    const first = harness();
    const secondIds = [
      '018f1e2c-7e3a-7000-8000-1234567890ad',
      '018f1e2c-7e3a-7000-8000-1234567890ae',
    ];
    let idIndex = 0;
    const second = createCreateHome({
      runTransaction: async (work) => work(TX),
      insertHome: () => Promise.resolve(),
      insertMembership: () => Promise.resolve(),
      clock: { now: () => OCCURRED_AT },
      ids: {
        next() {
          const id = secondIds[idIndex];
          idIndex += 1;
          if (id === undefined) {
            throw new Error('unexpected extra id');
          }
          return id;
        },
      },
    });

    const a = await first.create({
      userId: USER_ID,
      name: 'Oak Street',
      timezone: 'UTC',
    });
    const b = await second({
      userId: USER_ID,
      name: 'Pine Avenue',
      timezone: 'UTC',
    });
    assert.notEqual(a.home.id, b.home.id);
    assert.notEqual(a.membership.id, b.membership.id);
    assert.equal(a.membership.role, 'ADMIN');
    assert.equal(b.membership.role, 'ADMIN');
  });

  void it('rejects empty names and invalid timezones before opening a transaction', async () => {
    const empty = harness();
    await assert.rejects(
      empty.create({ userId: USER_ID, name: '   ', timezone: 'UTC' }),
      InvalidRequestError,
    );
    assert.deepEqual(empty.order, []);

    const timezone = harness();
    await assert.rejects(
      timezone.create({
        userId: USER_ID,
        name: 'Oak Street',
        timezone: 'Not/A/Zone',
      }),
      InvalidRequestError,
    );
    assert.deepEqual(timezone.order, []);
  });

  void it('rolls back the Home when Membership insert fails', async () => {
    const { create, homes, memberships, order, committed } = harness({
      membershipError: new TransactionInfrastructureError(),
    });
    await assert.rejects(
      create({
        userId: USER_ID,
        name: 'Oak Street',
        timezone: 'UTC',
      }),
      TransactionInfrastructureError,
    );
    assert.equal(committed, false);
    assert.deepEqual(order, [
      'begin',
      'home-insert',
      'membership-insert',
      'rollback',
    ]);
    assert.equal(homes.length, 1);
    assert.equal(memberships.length, 0);
  });

  void it('does not insert a Membership when Home insert fails', async () => {
    const { create, homes, memberships, order, committed } = harness({
      homeError: new TransactionInfrastructureError(),
    });
    await assert.rejects(
      create({
        userId: USER_ID,
        name: 'Oak Street',
        timezone: 'UTC',
      }),
      TransactionInfrastructureError,
    );
    assert.equal(committed, false);
    assert.deepEqual(order, ['begin', 'home-insert', 'rollback']);
    assert.equal(homes.length, 0);
    assert.equal(memberships.length, 0);
  });
});
