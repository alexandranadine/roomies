import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MaintenanceDetailProjection } from '../../domains/maintenance/maintenance.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { readMaintenanceEntry } from './read-maintenance-entry.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';
const CREATED = new Date('2026-09-13T18:00:00.000Z');

const actor: ActiveHomeActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  homeId: HOME,
  role: 'ROOMMATE',
};

function detail(
  overrides: Partial<MaintenanceDetailProjection> = {},
): MaintenanceDetailProjection {
  return {
    id: ENTRY,
    title: 'Leaky faucet',
    details: 'Kitchen sink',
    status: 'OPEN',
    visibility: 'PRIVATE',
    createdByMembershipId: actor.membershipId,
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function unusedRead(): never {
  throw new Error('must not read Maintenance on policy deny');
}

void describe('readMaintenanceEntry', () => {
  void it('returns the visible repository detail without reshaping it', async () => {
    const visible = detail();
    const calls: Array<{
      homeId: string;
      maintenanceEntryId: string;
      actorMembershipId: string;
    }> = [];
    const read = await readMaintenanceEntry(
      { actor, homeId: HOME, maintenanceEntryId: ENTRY },
      {
        findVisibleByHomeAndId: (
          homeId,
          maintenanceEntryId,
          actorMembershipId,
        ) => {
          calls.push({ homeId, maintenanceEntryId, actorMembershipId });
          return Promise.resolve(visible);
        },
      },
    );
    assert.equal(read, visible);
    assert.equal(read.details, 'Kitchen sink');
    assert.deepEqual(calls, [
      {
        homeId: HOME,
        maintenanceEntryId: ENTRY,
        actorMembershipId: actor.membershipId,
      },
    ]);
  });

  void it('lets an active Admin read through the same maintenance.read path', async () => {
    const read = await readMaintenanceEntry(
      {
        actor: { ...actor, role: 'ADMIN' },
        homeId: HOME,
        maintenanceEntryId: ENTRY,
      },
      {
        findVisibleByHomeAndId: (_homeId, _id, actorMembershipId) => {
          assert.equal(actorMembershipId, actor.membershipId);
          return Promise.resolve(detail({ visibility: 'HOUSEHOLD' }));
        },
      },
    );
    assert.equal(read.visibility, 'HOUSEHOLD');
  });

  void it('conceals a repository null as NOT_FOUND', async () => {
    await assert.rejects(
      () =>
        readMaintenanceEntry(
          { actor, homeId: HOME, maintenanceEntryId: ENTRY },
          {
            findVisibleByHomeAndId: () => Promise.resolve(null),
          },
        ),
      ConcealedNotFoundError,
    );
  });

  void it('conceals a Home-scope mismatch without reading Maintenance', async () => {
    await assert.rejects(
      () =>
        readMaintenanceEntry(
          { actor, homeId: OTHER_HOME, maintenanceEntryId: ENTRY },
          {
            findVisibleByHomeAndId: unusedRead,
          },
        ),
      ConcealedNotFoundError,
    );
  });
});
