import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAINTENANCE_LIST_DEFAULT_LIMIT } from '../../domains/maintenance/cursor.js';
import { InvalidMaintenanceRequestError } from '../../domains/maintenance/errors.js';
import type { MaintenanceListItemProjection } from '../../domains/maintenance/maintenance.js';
import type {
  ListVisibleMaintenanceEntries,
  MaintenanceVisiblePage,
} from '../../domains/maintenance/repository.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import { listHomeMaintenance } from './list-home-maintenance.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CREATED = new Date('2026-09-13T18:00:00.000Z');

const actor: ActiveHomeActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  homeId: HOME,
  role: 'ROOMMATE',
};

function item(
  overrides: Partial<MaintenanceListItemProjection> = {},
): MaintenanceListItemProjection {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    title: 'Leaky faucet',
    status: 'OPEN',
    visibility: 'HOUSEHOLD',
    createdByMembershipId: actor.membershipId,
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function page(
  overrides: Partial<MaintenanceVisiblePage> = {},
): MaintenanceVisiblePage {
  return {
    items: [item()],
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

function unusedList(): never {
  throw new Error('must not list Maintenance on policy deny');
}

void describe('listHomeMaintenance', () => {
  void it('returns the repository page without filtering or sorting', async () => {
    const repositoryPage = page({
      items: [
        item({ id: 'resolved-first-in-page', status: 'RESOLVED' }),
        item({ id: 'open-second-in-page', status: 'OPEN' }),
      ],
      hasMore: true,
      nextCursor: 'opaque-cursor',
    });
    const listed = await listHomeMaintenance(
      { actor, homeId: HOME },
      {
        listVisibleByHome: () => Promise.resolve(repositoryPage),
      },
    );
    assert.equal(listed, repositoryPage);
    assert.deepEqual(
      listed.items.map((row) => row.id),
      ['resolved-first-in-page', 'open-second-in-page'],
    );
    assert.equal(listed.hasMore, true);
    assert.equal(listed.nextCursor, 'opaque-cursor');
  });

  void it('preserves a valid empty page from the repository', async () => {
    const empty = page({ items: [], hasMore: false, nextCursor: null });
    const listed = await listHomeMaintenance(
      { actor, homeId: HOME },
      {
        listVisibleByHome: () => Promise.resolve(empty),
      },
    );
    assert.equal(listed, empty);
    assert.deepEqual(listed.items, []);
    assert.equal(listed.hasMore, false);
    assert.equal(listed.nextCursor, null);
  });

  void it('conceals a stale-scope repository null without converting it to empty', async () => {
    await assert.rejects(
      () =>
        listHomeMaintenance(
          { actor, homeId: HOME },
          {
            listVisibleByHome: () => Promise.resolve(null),
          },
        ),
      ConcealedNotFoundError,
    );
  });

  void it('passes actor Membership identity, default limit, and optional filters', async () => {
    const calls: ListVisibleMaintenanceEntries[] = [];
    await listHomeMaintenance(
      { actor, homeId: HOME },
      {
        listVisibleByHome: (input) => {
          calls.push(input);
          return Promise.resolve(page({ items: [] }));
        },
      },
    );
    await listHomeMaintenance(
      {
        actor: { ...actor, role: 'ADMIN' },
        homeId: HOME,
        limit: 10,
        cursor: 'next-page',
        status: 'OPEN',
      },
      {
        listVisibleByHome: (input) => {
          calls.push(input);
          return Promise.resolve(page({ items: [] }));
        },
      },
    );
    assert.deepEqual(calls, [
      {
        homeId: HOME,
        actorMembershipId: actor.membershipId,
        limit: MAINTENANCE_LIST_DEFAULT_LIMIT,
      },
      {
        homeId: HOME,
        actorMembershipId: actor.membershipId,
        limit: 10,
        cursor: 'next-page',
        status: 'OPEN',
      },
    ]);
    assert.equal('userId' in calls[0]!, false);
  });

  void it('maps invalid limit, status, and cursor failures to InvalidRequestError', async () => {
    await assert.rejects(
      () =>
        listHomeMaintenance(
          { actor, homeId: HOME, limit: 0 },
          {
            listVisibleByHome: () =>
              Promise.reject(new InvalidMaintenanceRequestError()),
          },
        ),
      InvalidRequestError,
    );
    await assert.rejects(
      () =>
        listHomeMaintenance(
          { actor, homeId: HOME, status: 'OPEN' },
          {
            listVisibleByHome: () =>
              Promise.reject(new InvalidMaintenanceRequestError()),
          },
        ),
      InvalidRequestError,
    );
    await assert.rejects(
      () =>
        listHomeMaintenance(
          { actor, homeId: HOME, cursor: '%%%' },
          {
            listVisibleByHome: () =>
              Promise.reject(new InvalidMaintenanceRequestError()),
          },
        ),
      InvalidRequestError,
    );
  });

  void it('conceals a Home-scope mismatch without reading Maintenance', async () => {
    await assert.rejects(
      () =>
        listHomeMaintenance(
          { actor, homeId: OTHER_HOME },
          {
            listVisibleByHome: unusedList,
          },
        ),
      ConcealedNotFoundError,
    );
  });
});
