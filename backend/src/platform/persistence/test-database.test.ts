import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSafeTestDatabase,
  parseDatabaseUrl,
  resolveTestDatabaseUrl,
  supportsParallelDestructiveReset,
} from './test-database.js';

void describe('test database safety', () => {
  void it('resolves TEST_DATABASE_URL ahead of DATABASE_URL', () => {
    const url = resolveTestDatabaseUrl({
      env: {
        TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/roomies_test',
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/roomies',
      },
    });
    assert.equal(url, 'postgresql://u:p@127.0.0.1:5432/roomies_test');
  });

  void it('parses without exposing credentials in the safe href', () => {
    const parsed = parseDatabaseUrl(
      'postgresql://roomies:super_secret@127.0.0.1:5432/roomies_test',
    );
    assert.equal(parsed.database, 'roomies_test');
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.equal(parsed.hrefWithoutCredentials.includes('super_secret'), false);
  });

  void it('allows local *_test databases', () => {
    const parsed = assertSafeTestDatabase(
      'postgresql://roomies:roomies_dev_only@127.0.0.1:5432/roomies_test',
    );
    assert.equal(parsed.database, 'roomies_test');
  });

  void it('allows roomies_ci on Compose service host', () => {
    const parsed = assertSafeTestDatabase(
      'postgresql://roomies:roomies@postgres:5432/roomies_ci',
    );
    assert.equal(parsed.database, 'roomies_ci');
  });

  void it('rejects the local development database name', () => {
    assert.throws(
      () =>
        assertSafeTestDatabase(
          'postgresql://roomies:roomies_dev_only@127.0.0.1:5432/roomies',
        ),
      /Refusing database name/,
    );
  });

  void it('rejects Neon-looking hosts', () => {
    assert.throws(
      () =>
        assertSafeTestDatabase(
          'postgresql://u:p@ep-cool.neon.tech:5432/roomies_test',
        ),
      /managed\/production/,
    );
  });

  void it('rejects production APP_ENV even for a test-named DB', () => {
    const previous = process.env['APP_ENV'];
    process.env['APP_ENV'] = 'production';
    try {
      assert.throws(
        () =>
          assertSafeTestDatabase(
            'postgresql://roomies:x@127.0.0.1:5432/roomies_test',
          ),
        /APP_ENV=production/,
      );
    } finally {
      if (previous === undefined) {
        delete process.env['APP_ENV'];
      } else {
        process.env['APP_ENV'] = previous;
      }
    }
  });

  void it('documents that parallel destructive reset is not supported yet', () => {
    assert.equal(supportsParallelDestructiveReset(), false);
  });
});
