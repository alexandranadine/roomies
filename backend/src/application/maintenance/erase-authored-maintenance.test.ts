import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MaintenancePersistenceError } from '../../domains/maintenance/errors.js';
import type { AuthoredMaintenanceSourceRef } from '../../domains/maintenance/repository.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { createEraseAuthoredMaintenance } from './erase-authored-maintenance.js';

const TX = {} as TransactionContext;
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SOURCE_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SOURCE_A = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function source(id: string, homeId: string): AuthoredMaintenanceSourceRef {
  return Object.freeze({ id, homeId });
}

void describe('createEraseAuthoredMaintenance', () => {
  void it('is a no-op for an empty membership list', async () => {
    const calls: string[] = [];
    const erase = createEraseAuthoredMaintenance({
      deleteNotificationsForSource() {
        calls.push('notifications');
        return Promise.resolve(0);
      },
      deleteActivitiesForSource() {
        calls.push('activities');
        return Promise.resolve();
      },
      maintenance: {
        lockAuthoredSourcesForErase() {
          calls.push('lock');
          return Promise.resolve(Object.freeze([]));
        },
        deleteAudienceForErasedSource() {
          calls.push('audience');
          return Promise.resolve();
        },
        deleteAuthoredSource() {
          calls.push('entry');
          return Promise.resolve();
        },
      },
    });

    await erase(TX, { membershipIds: [] });
    assert.deepEqual(calls, []);
  });

  void it('rejects invalid membership IDs before locking', async () => {
    const calls: string[] = [];
    const erase = createEraseAuthoredMaintenance({
      deleteNotificationsForSource() {
        calls.push('notifications');
        return Promise.resolve(0);
      },
      deleteActivitiesForSource() {
        calls.push('activities');
        return Promise.resolve();
      },
      maintenance: {
        lockAuthoredSourcesForErase() {
          calls.push('lock');
          return Promise.resolve(Object.freeze([]));
        },
        deleteAudienceForErasedSource() {
          calls.push('audience');
          return Promise.resolve();
        },
        deleteAuthoredSource() {
          calls.push('entry');
          return Promise.resolve();
        },
      },
    });

    await assert.rejects(
      () => erase(TX, { membershipIds: ['not-a-uuid'] }),
      MaintenancePersistenceError,
    );
    assert.deepEqual(calls, []);
  });

  void it('erases locked sources in notification-activity-audience-entry order', async () => {
    const calls: string[] = [];
    const erase = createEraseAuthoredMaintenance({
      deleteNotificationsForSource(_tx, input) {
        calls.push(`notifications:${input.homeId}:${input.sourceEntityId}`);
        assert.equal(input.sourceEntityType, 'MAINTENANCE');
        return Promise.resolve(0);
      },
      deleteActivitiesForSource(_tx, input) {
        calls.push(`activities:${input.homeId}:${input.sourceEntityId}`);
        assert.equal(input.sourceEntityType, 'MAINTENANCE');
        return Promise.resolve();
      },
      maintenance: {
        lockAuthoredSourcesForErase(_tx, input) {
          calls.push(`lock:${[...input.membershipIds].join(',')}`);
          return Promise.resolve(
            Object.freeze([source(SOURCE_A, HOME_A), source(SOURCE_B, HOME_B)]),
          );
        },
        deleteAudienceForErasedSource(_tx, locked) {
          calls.push(`audience:${locked.homeId}:${locked.id}`);
          return Promise.resolve();
        },
        deleteAuthoredSource(_tx, locked) {
          calls.push(`entry:${locked.homeId}:${locked.id}`);
          return Promise.resolve();
        },
      },
    });

    await erase(TX, { membershipIds: [MEMBER_B, MEMBER_A, MEMBER_A] });
    assert.deepEqual(calls, [
      `lock:${MEMBER_A},${MEMBER_B}`,
      `notifications:${HOME_A}:${SOURCE_A}`,
      `activities:${HOME_A}:${SOURCE_A}`,
      `audience:${HOME_A}:${SOURCE_A}`,
      `entry:${HOME_A}:${SOURCE_A}`,
      `notifications:${HOME_B}:${SOURCE_B}`,
      `activities:${HOME_B}:${SOURCE_B}`,
      `audience:${HOME_B}:${SOURCE_B}`,
      `entry:${HOME_B}:${SOURCE_B}`,
    ]);
  });
});
