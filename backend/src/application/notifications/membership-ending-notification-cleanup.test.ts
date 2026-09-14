import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createMembershipEndingNotificationCleanup,
  type MembershipEndingNotificationCleanupNotifications,
} from './membership-ending-notification-cleanup.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REJOINED_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');

const TX: TransactionContext = {
  query: () => Promise.reject(new Error('cleanup must use repository methods')),
};

type Row = {
  id: string;
  homeId: string;
  recipientMembershipId: string;
  actorMembershipId: string | null;
};

function storeOf(rows: Row[]) {
  const calls: { homeId: string; recipientMembershipId: string }[] = [];
  const notifications: MembershipEndingNotificationCleanupNotifications = {
    deleteByRecipientMembership(_tx, input) {
      calls.push(input);
      let deleted = 0;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (
          row &&
          row.homeId === input.homeId &&
          row.recipientMembershipId === input.recipientMembershipId
        ) {
          rows.splice(index, 1);
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    },
  };
  return {
    rows,
    calls,
    cleanup: createMembershipEndingNotificationCleanup(notifications),
  };
}

void describe('membership-ending Notification cleanup application seam', () => {
  void it('deletes only exact-tenure recipient rows', async () => {
    const store = storeOf([
      {
        id: 'to-recipient',
        homeId: HOME,
        recipientMembershipId: MEMBERSHIP,
        actorMembershipId: OTHER_MEMBERSHIP,
      },
      {
        id: 'actor-only',
        homeId: HOME,
        recipientMembershipId: OTHER_MEMBERSHIP,
        actorMembershipId: MEMBERSHIP,
      },
      {
        id: 'other-home',
        homeId: OTHER_HOME,
        recipientMembershipId: MEMBERSHIP,
        actorMembershipId: null,
      },
    ]);
    await store.cleanup.handleMembershipEnded(TX, {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'VOLUNTARY_LEAVE',
    });
    assert.deepEqual(store.calls, [
      { homeId: HOME, recipientMembershipId: MEMBERSHIP },
    ]);
    assert.deepEqual(
      store.rows.map((row) => row.id),
      ['actor-only', 'other-home'],
    );
  });

  void it('rejoin cleanup cannot target historical tenure A', async () => {
    const store = storeOf([
      {
        id: 'historical-a',
        homeId: HOME,
        recipientMembershipId: MEMBERSHIP,
        actorMembershipId: null,
      },
    ]);
    await store.cleanup.handleMembershipEnded(TX, {
      homeId: HOME,
      membershipId: REJOINED_MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'VOLUNTARY_LEAVE',
    });
    assert.equal(store.rows[0]?.id, 'historical-a');
  });

  void it('does not log source IDs or private content', async () => {
    const source = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'membership-ending-notification-cleanup.ts',
      ),
      'utf8',
    );
    assert.doesNotMatch(source, /console\./);
    assert.doesNotMatch(source, /title|details|audience|email|userId/);
    assert.doesNotMatch(source, /sourceEntityId|sourceOutboxEventId/);
  });
});
