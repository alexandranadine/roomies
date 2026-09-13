import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type { MembershipEndingSupplyCleanup } from './membership-ending-cleanup.js';
import { createTemporaryNoOpMembershipEndingSupplyCleanup } from './temporary-noop-membership-ending-supply-cleanup.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');

function forbiddenTx(): TransactionContext {
  return {
    query() {
      return Promise.reject(new Error('no-op adapter must not issue SQL'));
    },
  };
}

function isSupplyCleanup(
  value: unknown,
): value is MembershipEndingSupplyCleanup {
  return (
    typeof value === 'object' &&
    value !== null &&
    'handleMembershipEnded' in value &&
    typeof value.handleMembershipEnded === 'function'
  );
}

void describe('temporary no-op membership ending cleanup adapters', () => {
  void it('implements the public Supply port without SQL, connections, or events', async () => {
    const cleanup = createTemporaryNoOpMembershipEndingSupplyCleanup();
    assert.equal(isSupplyCleanup(cleanup), true);
    await cleanup.handleMembershipEnded(forbiddenTx(), {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'ADMIN_REMOVAL',
    });
  });

  void it('no longer ships a temporary Task no-op that production can select', async () => {
    await assert.rejects(
      () =>
        readFile(
          path.join(dir, 'temporary-noop-membership-ending-task-cleanup.ts'),
          'utf8',
        ),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  void it('names the Supply adapter as a temporary no-op with a visible replacement obligation', async () => {
    const supplySource = await readFile(
      path.join(dir, 'temporary-noop-membership-ending-supply-cleanup.ts'),
      'utf8',
    );

    assert.match(supplySource, /TEMPORARY no-op Supply cleanup/);
    assert.match(supplySource, /MUST be[\s\S]*replaced when M4 Supplies ships/);
    assert.match(
      supplySource,
      /createTemporaryNoOpMembershipEndingSupplyCleanup/,
    );
    assert.doesNotMatch(supplySource, /end-membership-within-home-structure/);
    assert.doesNotMatch(supplySource, /pool\.connect/);
    assert.doesNotMatch(supplySource, /tx\.query/);
    assert.doesNotMatch(supplySource, /outbox/i);
    assert.doesNotMatch(supplySource, /INSERT /i);
    assert.doesNotMatch(supplySource, /UPDATE /i);
  });
});
