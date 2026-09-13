import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isCompleteOpenLifecycle,
  isCompleteResolvedLifecycle,
  isMaintenanceStatus,
  isMaintenanceVisibility,
  isValidMaintenanceLifecycle,
  maintenanceStatusRank,
} from './maintenance.js';

const CREATED = new Date('2026-09-13T12:00:00.000Z');
const LATER = new Date('2026-09-13T13:00:00.000Z');
const EARLIER = new Date('2026-09-13T11:00:00.000Z');
const RESOLVER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

void describe('Maintenance lifecycle parser', () => {
  void it('accepts only frozen visibility and status values', () => {
    assert.equal(isMaintenanceVisibility('HOUSEHOLD'), true);
    assert.equal(isMaintenanceVisibility('PRIVATE'), true);
    assert.equal(isMaintenanceVisibility('ADMIN'), false);
    assert.equal(isMaintenanceStatus('OPEN'), true);
    assert.equal(isMaintenanceStatus('RESOLVED'), true);
    assert.equal(isMaintenanceStatus('CANCELED'), false);
    assert.equal(maintenanceStatusRank('OPEN'), 0);
    assert.equal(maintenanceStatusRank('RESOLVED'), 1);
  });

  void it('accepts complete OPEN and RESOLVED matrices', () => {
    assert.equal(
      isCompleteOpenLifecycle({
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
      }),
      true,
    );
    assert.equal(
      isValidMaintenanceLifecycle({
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      }),
      true,
    );
    assert.equal(
      isCompleteResolvedLifecycle({
        status: 'RESOLVED',
        resolvedByMembershipId: RESOLVER,
        resolvedAt: LATER,
      }),
      true,
    );
    assert.equal(
      isValidMaintenanceLifecycle({
        status: 'RESOLVED',
        resolvedByMembershipId: RESOLVER,
        resolvedAt: LATER,
        createdAt: CREATED,
        updatedAt: LATER,
      }),
      true,
    );
  });

  void it('rejects mixed lifecycle matrices', () => {
    const mixed = [
      {
        status: 'OPEN' as const,
        resolvedByMembershipId: RESOLVER,
        resolvedAt: null,
      },
      {
        status: 'OPEN' as const,
        resolvedByMembershipId: null,
        resolvedAt: LATER,
      },
      {
        status: 'OPEN' as const,
        resolvedByMembershipId: RESOLVER,
        resolvedAt: LATER,
      },
      {
        status: 'RESOLVED' as const,
        resolvedByMembershipId: null,
        resolvedAt: LATER,
      },
      {
        status: 'RESOLVED' as const,
        resolvedByMembershipId: RESOLVER,
        resolvedAt: null,
      },
      {
        status: 'RESOLVED' as const,
        resolvedByMembershipId: null,
        resolvedAt: null,
      },
    ];
    for (const input of mixed) {
      assert.equal(
        isValidMaintenanceLifecycle({
          ...input,
          createdAt: CREATED,
          updatedAt: LATER,
        }),
        false,
        JSON.stringify(input),
      );
    }
  });

  void it('rejects resolvedAt and updatedAt time inversions', () => {
    assert.equal(
      isValidMaintenanceLifecycle({
        status: 'OPEN',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: CREATED,
        updatedAt: EARLIER,
      }),
      false,
    );
    assert.equal(
      isValidMaintenanceLifecycle({
        status: 'RESOLVED',
        resolvedByMembershipId: RESOLVER,
        resolvedAt: EARLIER,
        createdAt: CREATED,
        updatedAt: LATER,
      }),
      false,
    );
    assert.equal(
      isValidMaintenanceLifecycle({
        status: 'RESOLVED',
        resolvedByMembershipId: RESOLVER,
        resolvedAt: new Date('2026-09-13T14:00:00.000Z'),
        createdAt: CREATED,
        updatedAt: LATER,
      }),
      false,
    );
  });
});
