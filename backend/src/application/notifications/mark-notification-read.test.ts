import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { markNotificationRead } from './mark-notification-read.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ENTRY = '018f1e2c-7e3a-7000-8000-1234567890ab';

const unusedTx = {} as TransactionContext;

void describe('markNotificationRead', () => {
  void it('returns after an eligible mark or already-read row', async () => {
    const seen: string[] = [];
    await markNotificationRead(
      { userId: USER, notificationId: ENTRY },
      {
        notifications: {
          markEligibleRead(_tx, input) {
            seen.push(input.notificationId);
            return Promise.resolve({
              outcome: 'marked',
              readAt: new Date('2026-09-13T18:00:00.000Z'),
            });
          },
        },
        runTransaction: (work) => work(unusedTx),
      },
    );
    await markNotificationRead(
      { userId: USER, notificationId: ENTRY },
      {
        notifications: {
          markEligibleRead() {
            return Promise.resolve({
              outcome: 'already_read',
              readAt: new Date('2026-09-13T18:00:00.000Z'),
            });
          },
        },
        runTransaction: (work) => work(unusedTx),
      },
    );
    assert.deepEqual(seen, [ENTRY]);
  });

  void it('conceals an ineligible row as 404', async () => {
    await assert.rejects(
      () =>
        markNotificationRead(
          { userId: USER, notificationId: ENTRY },
          {
            notifications: {
              markEligibleRead: () => Promise.resolve({ outcome: 'not_found' }),
            },
            runTransaction: (work) => work(unusedTx),
          },
        ),
      ConcealedNotFoundError,
    );
  });
});
