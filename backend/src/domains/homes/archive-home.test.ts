import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  ARCHIVE_ACTIVE_HOME_SQL,
  createHomeArchiveWriter,
} from './archive-home.js';

void describe('Home archive writer', () => {
  void it('updates archived_at only for the exact active Home', async () => {
    const calls: unknown[] = [];
    const archivedAt = new Date('2026-09-12T20:00:00.000Z');
    const homeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const tx: TransactionContext = {
      query: (text, values) => {
        calls.push({ text, values });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    };

    assert.equal(
      await createHomeArchiveWriter().archiveActiveHome(tx, {
        homeId,
        archivedAt,
      }),
      1,
    );
    assert.deepEqual(calls, [
      { text: ARCHIVE_ACTIVE_HOME_SQL, values: [archivedAt, homeId] },
    ]);
    assert.match(ARCHIVE_ACTIVE_HOME_SQL, /SET archived_at = \$1/);
    assert.match(ARCHIVE_ACTIVE_HOME_SQL, /id = \$2/);
    assert.match(ARCHIVE_ACTIVE_HOME_SQL, /archived_at IS NULL/);
  });

  void it('normalizes query failures to infrastructure error', async () => {
    const tx: TransactionContext = {
      query: () => Promise.reject(new Error('secret database detail')),
    };
    await assert.rejects(
      () =>
        createHomeArchiveWriter().archiveActiveHome(tx, {
          homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          archivedAt: new Date(),
        }),
      TransactionInfrastructureError,
    );
  });
});
