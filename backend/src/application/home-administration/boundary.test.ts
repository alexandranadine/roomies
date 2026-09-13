import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function walkProduction(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkProduction(full)));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

void describe('home-administration application boundary', () => {
  void it('coordinates public Home/Membership/outbox surfaces without repository internals', async () => {
    const source = await readFile(
      path.join(dir, 'change-membership-role.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /ended_at\s*=/);
    assert.doesNotMatch(source, /user_id\s*=/);
    assert.match(source, /lockHomeStructure/);
    assert.match(source, /decideMembershipChangeRole/);
    assert.match(
      source,
      /membership\.role_changed\.v1|createMembershipRoleChangedV1Event/,
    );
  });

  void it('keeps membership ending on public ports without owning the transaction', async () => {
    const source = await readFile(
      path.join(dir, 'end-membership-within-home-structure.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /BEGIN/);
    assert.doesNotMatch(source, /COMMIT/);
    assert.doesNotMatch(source, /ROLLBACK/);
    assert.doesNotMatch(source, /pool\.connect/);
    assert.doesNotMatch(source, /runInReadCommittedTransaction/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /canEndMembership/);
    assert.doesNotMatch(source, /ended_at\s*=/);
    assert.doesNotMatch(source, /user_id/);
    assert.doesNotMatch(source, /lockHomeStructure/);
    assert.doesNotMatch(source, /ForbiddenError/);
    assert.match(source, /handleMembershipEnded/);
    assert.match(source, /createMembershipEndedV1Event/);
    assert.match(source, /createMembershipEndingTaskCleanupFromPool/);
    assert.match(source, /createTemporaryNoOpMembershipEndingSupplyCleanup/);
    assert.doesNotMatch(
      source,
      /createTemporaryNoOpMembershipEndingTaskCleanup/,
    );
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.doesNotMatch(source, /FROM\s+task_instances/i);
    assert.doesNotMatch(source, /FROM\s+task_definitions/i);
  });

  void it('orchestrates voluntary leave through the locked structure and ending seam', async () => {
    const source = await readFile(
      path.join(dir, 'leave-membership.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /ended_at\s*=/);
    assert.doesNotMatch(source, /user_id\s*=/);
    assert.doesNotMatch(source, /decideMembershipChangeRole/);
    assert.doesNotMatch(source, /updateActiveRole/);
    assert.doesNotMatch(source, /membership\.remove/);
    assert.doesNotMatch(source, /home\.archiveFinalMember/);
    assert.match(source, /lockHomeStructure/);
    assert.match(source, /decideMembershipLeave/);
    assert.match(source, /decideMembershipLeaveSelf/);
    assert.match(source, /VOLUNTARY_LEAVE/);
    assert.match(source, /createEndMembershipWithinHomeStructureFromPool/);
    assert.doesNotMatch(source, /endMembership\?:/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.ok(
      source.lastIndexOf('deps.clock.now()') >
        source.lastIndexOf('lockHomeStructure(tx'),
    );
  });

  void it('orchestrates admin remove through the locked structure and ending seam', async () => {
    const source = await readFile(
      path.join(dir, 'remove-membership.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /home-repository/);
    assert.doesNotMatch(source, /active-home-actor-lookup/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /ended_at\s*=/);
    assert.doesNotMatch(source, /user_id\s*=/);
    assert.doesNotMatch(source, /decideMembershipChangeRole/);
    assert.doesNotMatch(source, /decideMembershipLeave/);
    assert.doesNotMatch(source, /updateActiveRole/);
    assert.doesNotMatch(source, /VOLUNTARY_LEAVE/);
    assert.doesNotMatch(source, /home\.archiveFinalMember/);
    assert.doesNotMatch(source, /LAST_ROOMMATE_REQUIRES_ARCHIVE/);
    assert.match(source, /lockHomeStructure/);
    assert.match(source, /decideMembershipRemove/);
    assert.match(source, /decideMembershipRemoveSelf/);
    assert.match(source, /ADMIN_REMOVAL/);
    assert.match(source, /createEndMembershipWithinHomeStructureFromPool/);
    assert.doesNotMatch(source, /endMembership\?:/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.ok(
      source.lastIndexOf('deps.clock.now()') >
        source.lastIndexOf('lockHomeStructure(tx'),
    );
  });

  void it('owns final archive sequencing without repository or fake lock infrastructure', async () => {
    const source = await readFile(
      path.join(dir, 'archive-final-member-home.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /TaskLock|SupplyLock|MaintenanceLock/);
    assert.doesNotMatch(source, /invitationRevoker\?:/);
    assert.doesNotMatch(source, /emitEvent|suppressEvent/);
    assert.match(source, /lockHomeStructure/);
    assert.match(source, /decideArchiveFinalMember/);
    assert.match(source, /createInvitationHomeArchiveCleanupFromPool/);
    assert.match(
      source,
      /createApplyMembershipEndingWithinHomeStructureFromPool/,
    );
    assert.match(source, /applyMembershipEnding/);
    assert.match(source, /archiveActiveHome/);
    assert.doesNotMatch(source, /tasks\/repository/);
    assert.doesNotMatch(
      source,
      /TemporaryNoOpFinalMemberArchiveInvitationRevoker/,
    );
    assert.doesNotMatch(source, /invitations\/repository/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.ok(
      source.lastIndexOf('createMembershipEndedV1Event') <
        source.lastIndexOf('createHomeArchivedV1Event'),
    );
    assert.ok(
      source.lastIndexOf('deps.clock.now()') >
        source.lastIndexOf('lockHomeStructure(tx'),
    );
    assert.ok(
      source.lastIndexOf('deps.clock.now()') >
        source.lastIndexOf('decideArchiveFinalMember'),
    );
  });

  void it('makes Task cleanup public-seam-only and Supply no-op replacement obligatory', async () => {
    const composition = await readFile(
      path.join(dir, 'end-membership-within-home-structure.ts'),
      'utf8',
    );
    assert.match(composition, /createEndMembershipWithinHomeStructureFromPool/);
    assert.match(composition, /createMembershipEndingTaskCleanupFromPool/);
    assert.match(composition, /MUST be replaced when M4 Supplies/);
    assert.doesNotMatch(composition, /taskCleanup\?:/);
    assert.doesNotMatch(composition, /supplyCleanup\?:/);
    assert.doesNotMatch(
      composition,
      /createTemporaryNoOpMembershipEndingTaskCleanup/,
    );
    assert.doesNotMatch(composition, /tasks\/repository/);
    assert.doesNotMatch(composition, /FROM\s+task_instances/i);
    assert.doesNotMatch(composition, /FROM\s+task_definitions/i);

    const files = await walkProduction(dir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = file.replaceAll('\\', '/');
      assert.doesNotMatch(source, /memberships\/repository/, rel);
      assert.doesNotMatch(source, /homes\/repository/, rel);
      assert.doesNotMatch(source, /tasks\/repository/, rel);
      assert.doesNotMatch(source, /from ['"]express['"]/, rel);
      assert.doesNotMatch(source, /better-auth/, rel);
      assert.doesNotMatch(source, /from ['"]pg['"]/, rel);
    }
  });

  void it('orchestrates invitation creation without outbox, HTTP, or Date.now', async () => {
    const source = await readFile(
      path.join(dir, 'create-invitation.ts'),
      'utf8',
    );
    assert.match(source, /lockHomeStructure/);
    assert.match(source, /decideInvitationCreate/);
    assert.match(source, /findEffectivePending/);
    assert.match(source, /findCanonicalIdentityByEmail/);
    assert.match(source, /normalizeEmail/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /invitation\.created/);
    assert.doesNotMatch(source, /membership\.started/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
  });

  void it('orchestrates invitation revocation without outbox, HTTP, or Date.now', async () => {
    const source = await readFile(
      path.join(dir, 'revoke-invitation.ts'),
      'utf8',
    );
    assert.match(source, /lockHomeStructure/);
    assert.match(source, /decideInvitationRevoke/);
    assert.match(source, /lockById/);
    assert.match(source, /revokeLocked/);
    assert.match(source, /projectInvitationLifecycle/);
    assert.match(source, /ADMIN_REVOKED/);
    assert.doesNotMatch(source, /from ['"]express['"]/);
    assert.doesNotMatch(source, /better-auth/);
    assert.doesNotMatch(source, /from ['"]pg['"]/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /invitation\.revoked/);
    assert.doesNotMatch(source, /membership\.started/);
    assert.doesNotMatch(source, /Authorization: Invitation/);
    assert.doesNotMatch(source, /tokenHash|rawSecret|inviteUrl/);
    assert.doesNotMatch(source, /SERIALIZABLE/);
    assert.doesNotMatch(source, /pg_advisory/i);
    assert.doesNotMatch(source, /memberships\/repository/);
    assert.doesNotMatch(source, /homes\/repository/);
  });
});
