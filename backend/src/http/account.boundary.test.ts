import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

void describe('account HTTP boundary', () => {
  void it('expires the session cookie only through the M8.5 post-commit helper', async () => {
    const source = await readFile(
      new URL('./account.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /appendExpiredAuthSessionCookieAfterCommit/);
    assert.match(source, /requireFreshAccountDeletionSession/);
    assert.match(source, /confirmation: z\.literal\('DELETE'\)/);
    assert.match(source, /\.strict\(\)/);
    assert.doesNotMatch(source, /signOut/);
    assert.doesNotMatch(source, /deleteUser|delete-user/);
    assert.doesNotMatch(source, /auth\.api/);
    assert.doesNotMatch(source, /Date\.now/);
    assert.doesNotMatch(source, /updatedAt|expiresAt/);
    assert.doesNotMatch(source, /console\.(?:log|info|debug)\(/);
    assert.doesNotMatch(source, /FROM\s+users/i);
    assert.doesNotMatch(source, /better-auth/);
  });
});
