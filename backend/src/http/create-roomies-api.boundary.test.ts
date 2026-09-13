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
});
