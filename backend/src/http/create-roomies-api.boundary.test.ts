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
});
