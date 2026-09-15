import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL } from './find-maintenance-activity-source.js';
import { FIND_MAINTENANCE_NOTIFICATION_SOURCE_SQL } from './find-maintenance-notification-source.js';
import { maintenanceSourceLockSql } from './maintenance-source-lock.js';

void describe('maintenanceSourceLockSql', () => {
  void it('leaves the unlocked Activity projection SQL unchanged', () => {
    assert.equal(
      maintenanceSourceLockSql(FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL, undefined),
      FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL,
    );
    assert.equal(
      maintenanceSourceLockSql(FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL, 'none'),
      FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL,
    );
    assert.doesNotMatch(
      maintenanceSourceLockSql(FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL, 'none'),
      /FOR UPDATE/,
    );
  });

  void it('appends FOR UPDATE for a locking Activity or Notification read', () => {
    const activity = maintenanceSourceLockSql(
      FIND_MAINTENANCE_ACTIVITY_SOURCE_SQL,
      'forUpdate',
    );
    const notification = maintenanceSourceLockSql(
      FIND_MAINTENANCE_NOTIFICATION_SOURCE_SQL,
      'forUpdate',
    );
    assert.match(activity, /FOR UPDATE\s*$/);
    assert.match(notification, /FOR UPDATE\s*$/);
    assert.doesNotMatch(activity, /title|details|user_id|email/);
    assert.doesNotMatch(notification, /title|details|user_id|email/);
  });
});
