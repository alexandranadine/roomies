import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

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
});
