import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isNotificationKind,
  isNotificationKindSourceCompatible,
  isNotificationSourceEntityType,
  NOTIFICATION_KIND_SOURCE_TYPE,
  NOTIFICATION_KINDS,
  NOTIFICATION_SOURCE_ENTITY_TYPES,
} from './notification.js';

void describe('Notification closed vocabulary', () => {
  void it('keeps October kinds and source types closed', () => {
    assert.deepEqual(
      [...NOTIFICATION_KINDS],
      [
        'MEMBERSHIP_ROLE_CHANGED',
        'ASSIGNED_TASK_COMPLETED',
        'CREATED_SUPPLY_OBTAINED',
        'PRIVATE_MAINTENANCE_CREATED',
        'PRIVATE_MAINTENANCE_RESOLVED',
      ],
    );
    assert.deepEqual(
      [...NOTIFICATION_SOURCE_ENTITY_TYPES],
      ['MEMBERSHIP', 'TASK', 'SUPPLY', 'MAINTENANCE'],
    );
    assert.equal(isNotificationKind('HOUSE_PULSE'), false);
    assert.equal(isNotificationSourceEntityType('INVITATION'), false);
  });

  void it('enforces the frozen kind/source matrix', () => {
    assert.deepEqual(NOTIFICATION_KIND_SOURCE_TYPE, {
      MEMBERSHIP_ROLE_CHANGED: 'MEMBERSHIP',
      ASSIGNED_TASK_COMPLETED: 'TASK',
      CREATED_SUPPLY_OBTAINED: 'SUPPLY',
      PRIVATE_MAINTENANCE_CREATED: 'MAINTENANCE',
      PRIVATE_MAINTENANCE_RESOLVED: 'MAINTENANCE',
    });
    assert.equal(
      isNotificationKindSourceCompatible(
        'MEMBERSHIP_ROLE_CHANGED',
        'MEMBERSHIP',
      ),
      true,
    );
    assert.equal(
      isNotificationKindSourceCompatible('ASSIGNED_TASK_COMPLETED', 'TASK'),
      true,
    );
    assert.equal(
      isNotificationKindSourceCompatible('CREATED_SUPPLY_OBTAINED', 'SUPPLY'),
      true,
    );
    assert.equal(
      isNotificationKindSourceCompatible(
        'PRIVATE_MAINTENANCE_CREATED',
        'MAINTENANCE',
      ),
      true,
    );
    assert.equal(
      isNotificationKindSourceCompatible(
        'PRIVATE_MAINTENANCE_RESOLVED',
        'MAINTENANCE',
      ),
      true,
    );
    assert.equal(
      isNotificationKindSourceCompatible('MEMBERSHIP_ROLE_CHANGED', 'TASK'),
      false,
    );
    assert.equal(
      isNotificationKindSourceCompatible(
        'PRIVATE_MAINTENANCE_CREATED',
        'MEMBERSHIP',
      ),
      false,
    );
  });
});
