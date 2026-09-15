import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function productionFiles(): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => path.join(dir, entry.name));
}

void describe('activity application boundary', () => {
  void it('projects through the public Maintenance source port only', async () => {
    const source = await readFile(path.join(dir, 'outbox-handler.ts'), 'utf8');
    assert.match(source, /handlerId: ACTIVITY_OUTBOX_HANDLER_ID/);
    assert.match(source, /ACTIVITY_OUTBOX_HANDLER_ID = 'activity'/);
    assert.match(source, /MAINTENANCE_CREATED_V1/);
    assert.match(source, /MAINTENANCE_RESOLVED_V1/);
    assert.match(source, /TASK_COMPLETED_V1/);
    assert.match(source, /SUPPLY_OBTAINED_V1/);
    assert.match(source, /MEMBERSHIP_STARTED_V1/);
    assert.match(source, /MEMBERSHIP_ENDED_V1/);
    assert.match(source, /MEMBERSHIP_ROLE_CHANGED_V1/);
    assert.match(source, /findMaintenanceActivitySource/);
    assert.match(source, /lockHomeAndExactMemberships/);
    assert.match(source, /lock: 'forUpdate'/);
    assert.match(source, /findTaskActivitySource/);
    assert.match(source, /findSupplyActivitySource/);
    assert.match(source, /findMembershipStartedActivitySource/);
    assert.match(source, /findMembershipEndedActivitySource/);
    assert.match(source, /findMembershipRoleTransitionActivitySource/);
    assert.match(source, /insertHomeVisibleActivity/);
    assert.match(source, /insertSourceAuthorizedActivity/);
    assert.match(source, /duplicate_source_outbox_event/);
    assert.doesNotMatch(source, /maintenance\/repository/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.doesNotMatch(source, /supplies\/repository/);
    assert.doesNotMatch(source, /insertEntryWithAudience/);
    assert.doesNotMatch(source, /lockVisibleForResolve/);
    assert.doesNotMatch(source, /assignedMembershipId/);
    assert.doesNotMatch(source, /claimantMembershipId/);
    assert.doesNotMatch(source, /runInReadCommittedTransaction/);
    assert.doesNotMatch(source, /BEGIN/);
    assert.doesNotMatch(source, /COMMIT/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /userId/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /console\./);
    assert.doesNotMatch(source, /\.title/);
    assert.doesNotMatch(source, /\.details/);
    assert.doesNotMatch(source, /JSON\.stringify\(event\.payload\)/);
  });

  void it('lists through public repository visibility and display ports', async () => {
    const source = await readFile(
      path.join(dir, 'list-home-activity.ts'),
      'utf8',
    );
    assert.match(source, /decideActivityList/);
    assert.match(source, /listVisiblePageByHome/);
    assert.match(source, /actorMembershipId: input\.actor\.membershipId/);
    assert.match(source, /ACTIVITY_LIST_DEFAULT_LIMIT/);
    assert.match(source, /page === null/);
    assert.match(source, /ConcealedNotFoundError/);
    assert.match(source, /findHistoricalMembershipDisplays/);
    assert.match(source, /findTaskActivityDisplays/);
    assert.match(source, /findSupplyActivityDisplays/);
    assert.match(source, /findMaintenanceActivityDisplays/);
    assert.doesNotMatch(source, /items\.filter/);
    assert.doesNotMatch(source, /sort\(/);
    assert.doesNotMatch(source, /decodeActivityListCursor/);
    assert.doesNotMatch(source, /bindActivityListCursor/);
    assert.doesNotMatch(source, /userId/);
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /audienceMembershipIds/);
    assert.doesNotMatch(source, /\.details/);
    assert.doesNotMatch(source, /maintenance\/repository/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.doesNotMatch(source, /supplies\/repository/);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
  });

  void it('erases Maintenance-derived Activity through repository source deletes', async () => {
    const source = await readFile(
      path.join(dir, 'delete-activities-for-source.ts'),
      'utf8',
    );
    assert.match(source, /deleteRecipientsBySource/);
    assert.match(source, /deleteActivitiesBySource/);
    assert.match(source, /sourceEntityType: 'MAINTENANCE'/);
    assert.doesNotMatch(source, /runInReadCommittedTransaction/);
    assert.doesNotMatch(source, /BEGIN/);
    assert.doesNotMatch(source, /COMMIT/);
    assert.doesNotMatch(source, /maintenance\/repository/);
    assert.doesNotMatch(source, /notifications\/repository/);
    assert.doesNotMatch(source, /deleteByRecipientMembership/);
    assert.doesNotMatch(source, /title/);
    assert.doesNotMatch(source, /details/);
    assert.doesNotMatch(source, /console\./);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
  });

  void it('does not import sibling repository internals or HTTP', async () => {
    for (const file of await productionFiles()) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /maintenance\/repository/, rel);
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /tasks\/repository/, rel);
      assert.doesNotMatch(source, /supplies\/repository/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
    }
  });
});
