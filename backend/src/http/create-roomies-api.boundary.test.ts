import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

void describe('create-roomies-api composition boundary', () => {
  void it('does not import Membership repository internals or query tables', async () => {
    const source = await readFile(
      new URL('./create-roomies-api.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /FROM\s+memberships/i);
    assert.doesNotMatch(source, /FROM\s+homes/i);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /LIST_ACTIVE_HOMES_FOR_USER_SQL/);
    assert.doesNotMatch(source, /active-homes-for-user/);
  });

  void it('does not add Home role or capabilities to the principal', async () => {
    const source = await readFile(
      new URL('./create-roomies-api.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /principal\.(role|membershipId|homeId|capabilities)/,
    );
  });

  void it('wires Tasks through the existing Home context without a parallel authz path', async () => {
    const source = await readFile(
      new URL('./create-roomies-api.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /createTasksRouter/);
    assert.match(source, /createManualTask/);
    assert.match(source, /listHomeTasks/);
    assert.match(source, /completeTask/);
    assert.match(source, /activeHomeActorResolver/);
    assert.doesNotMatch(source, /createTaskActorResolver/);
    assert.doesNotMatch(source, /taskActor/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.doesNotMatch(source, /FROM\s+task_instances/i);
    assert.doesNotMatch(source, /better-auth/);
  });

  void it('wires leave and remove without archive or ending-seam internals', async () => {
    const source = await readFile(
      new URL('./create-roomies-api.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /leaveMembership/);
    assert.match(source, /removeMembership/);
    assert.doesNotMatch(source, /archiveHome/i);
    assert.doesNotMatch(source, /endMembershipWithinHomeStructure/);
    assert.doesNotMatch(source, /end-membership-within-home-structure/);
    assert.doesNotMatch(source, /decideMembershipLeave/);
    assert.doesNotMatch(source, /decideMembershipRemove/);
  });

  void it('wires current-user Notifications without Home context or repository SQL', async () => {
    const source = await readFile(
      new URL('./create-roomies-api.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /createNotificationsRouter/);
    assert.match(source, /listCurrentUserNotifications/);
    assert.match(source, /markNotificationRead/);
    assert.match(source, /readAllNotifications/);
    assert.match(source, /\/notifications/);
    assert.doesNotMatch(source, /notifications\/repository/);
    assert.doesNotMatch(source, /listEligiblePageForUser/);
    assert.doesNotMatch(source, /FROM\s+notifications/i);
  });

  void it('wires House Pulse through Home context without repository SQL', async () => {
    const source = await readFile(
      new URL('./create-roomies-api.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /createPulseRouter/);
    assert.match(source, /getHousePulse/);
    assert.match(source, /activeHomeActorResolver/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.doesNotMatch(source, /supplies\/repository/);
    assert.doesNotMatch(source, /maintenance\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /FROM\s+task_instances/i);
    assert.doesNotMatch(source, /FROM\s+supply_entries/i);
    assert.doesNotMatch(source, /FROM\s+maintenance_entries/i);
    assert.doesNotMatch(source, /SERIALIZABLE/);
  });

  void it('wires Activity list through Home context without repository SQL', async () => {
    const source = await readFile(
      new URL('./create-roomies-api.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /createActivityRouter/);
    assert.match(source, /listHomeActivity/);
    assert.match(source, /activeHomeActorResolver/);
    assert.doesNotMatch(source, /activity\/repository/);
    assert.doesNotMatch(source, /listVisiblePageByHome/);
    assert.doesNotMatch(source, /FROM\s+activities/i);
    assert.doesNotMatch(source, /activity_recipients/);
  });

  void it('wires active Membership list through Home context without SQL', async () => {
    const source = await readFile(
      new URL('./create-roomies-api.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /listActiveHomeMemberships/);
    assert.doesNotMatch(source, /LIST_ACTIVE_HOME_MEMBERSHIPS_SQL/);
    assert.doesNotMatch(source, /list-active-home-memberships-reader/);
    assert.doesNotMatch(source, /FROM\s+auth_identities/i);
    assert.doesNotMatch(source, /createMembershipActorResolver/);
  });
});
