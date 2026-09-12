import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type {
  MembershipEndingSupplyCleanup,
  MembershipEndingTaskCleanup,
} from './membership-ending-cleanup.js';
import { createTemporaryNoOpMembershipEndingSupplyCleanup } from './temporary-noop-membership-ending-supply-cleanup.js';
import { createTemporaryNoOpMembershipEndingTaskCleanup } from './temporary-noop-membership-ending-task-cleanup.js';

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

function isTaskCleanup(value: unknown): value is MembershipEndingTaskCleanup {
  return (
    typeof value === 'object' &&
    value !== null &&
    'handleMembershipEnded' in value &&
    typeof value.handleMembershipEnded === 'function'
  );
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
  void it('implements the public Task port without SQL, connections, or events', async () => {
    const cleanup = createTemporaryNoOpMembershipEndingTaskCleanup();
    assert.equal(isTaskCleanup(cleanup), true);
    await cleanup.handleMembershipEnded(forbiddenTx(), {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'VOLUNTARY_LEAVE',
    });
  });

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

  void it('names the adapters as temporary no-ops with a visible replacement obligation', async () => {
    const taskSource = await readFile(
      path.join(dir, 'temporary-noop-membership-ending-task-cleanup.ts'),
      'utf8',
    );
    const supplySource = await readFile(
      path.join(dir, 'temporary-noop-membership-ending-supply-cleanup.ts'),
      'utf8',
    );

    assert.match(taskSource, /TEMPORARY no-op Task cleanup/);
    assert.match(taskSource, /MUST be[\s\S]*replaced when M3 Tasks ships/);
    assert.match(taskSource, /createTemporaryNoOpMembershipEndingTaskCleanup/);
    assert.doesNotMatch(taskSource, /end-membership-within-home-structure/);
    assert.doesNotMatch(taskSource, /pool\.connect/);
    assert.doesNotMatch(taskSource, /tx\.query/);
    assert.doesNotMatch(taskSource, /outbox/i);
    assert.doesNotMatch(taskSource, /INSERT /i);
    assert.doesNotMatch(taskSource, /UPDATE /i);

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
