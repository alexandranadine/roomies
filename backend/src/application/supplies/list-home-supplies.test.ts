import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SupplyEntry } from '../../domains/supplies/supply.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { listHomeSupplies } from './list-home-supplies.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CREATED = new Date('2026-09-12T18:00:00.000Z');

const actor: ActiveHomeActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  homeId: HOME,
  role: 'ROOMMATE',
};

function entry(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    homeId: HOME,
    title: 'Paper towels',
    status: 'OPEN',
    createdByMembershipId: actor.membershipId,
    obtainedAt: null,
    canceledAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

void describe('listHomeSupplies', () => {
  void it('returns the authorized Home snapshot list including an empty Home', async () => {
    const empty = await listHomeSupplies(
      { actor, homeId: HOME },
      {
        listOpenEntriesByHome: () =>
          Promise.reject(new Error('must not list OPEN-only when unfiltered')),
        listSupplyEntriesByHome: () => Promise.resolve([]),
        listSupplyEntriesByHomeAndStatus: () =>
          Promise.reject(new Error('must not filter when status omitted')),
      },
    );
    assert.deepEqual(empty, []);

    const rows = [entry(), entry({ id: 'other', status: 'CANCELED' })];
    const listed = await listHomeSupplies(
      { actor, homeId: HOME },
      {
        listOpenEntriesByHome: () => Promise.resolve([]),
        listSupplyEntriesByHome: (homeId) =>
          Promise.resolve(homeId === HOME ? rows : []),
        listSupplyEntriesByHomeAndStatus: () => Promise.resolve([]),
      },
    );
    assert.equal(listed.length, 2);
  });

  void it('lets an active Admin list through the same supply.list path', async () => {
    const listed = await listHomeSupplies(
      { actor: { ...actor, role: 'ADMIN' }, homeId: HOME },
      {
        listOpenEntriesByHome: () => Promise.resolve([]),
        listSupplyEntriesByHome: () => Promise.resolve([entry()]),
        listSupplyEntriesByHomeAndStatus: () => Promise.resolve([]),
      },
    );
    assert.equal(listed.length, 1);
  });

  void it('uses OPEN-only listing when status=OPEN', async () => {
    const listed = await listHomeSupplies(
      { actor, homeId: HOME, status: 'OPEN' },
      {
        listOpenEntriesByHome: (homeId) =>
          Promise.resolve(homeId === HOME ? [entry()] : []),
        listSupplyEntriesByHome: () =>
          Promise.reject(new Error('must not use all-list for OPEN')),
        listSupplyEntriesByHomeAndStatus: () =>
          Promise.reject(new Error('must not use status list for OPEN')),
      },
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, 'OPEN');
  });

  void it('uses status listing for terminal filters', async () => {
    const obtained = entry({
      status: 'OBTAINED',
      obtainedAt: CREATED,
    });
    const listed = await listHomeSupplies(
      { actor, homeId: HOME, status: 'OBTAINED' },
      {
        listOpenEntriesByHome: () =>
          Promise.reject(new Error('must not use OPEN list for OBTAINED')),
        listSupplyEntriesByHome: () =>
          Promise.reject(new Error('must not use all-list for OBTAINED')),
        listSupplyEntriesByHomeAndStatus: (homeId, status) =>
          Promise.resolve(
            homeId === HOME && status === 'OBTAINED' ? [obtained] : [],
          ),
      },
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, 'OBTAINED');
  });

  void it('conceals a Home-scope mismatch without reading Supplies', async () => {
    await assert.rejects(
      () =>
        listHomeSupplies(
          { actor, homeId: OTHER_HOME },
          {
            listOpenEntriesByHome: () =>
              Promise.reject(new Error('must not list on policy deny')),
            listSupplyEntriesByHome: () =>
              Promise.reject(new Error('must not list on policy deny')),
            listSupplyEntriesByHomeAndStatus: () =>
              Promise.reject(new Error('must not list on policy deny')),
          },
        ),
      ConcealedNotFoundError,
    );
  });
});
