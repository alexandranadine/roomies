import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { readAllNotifications } from './read-all-notifications.js';

const USER = '11111111-1111-4111-8111-111111111111';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const READ_THROUGH = new Date('2026-09-13T18:00:00.000Z');

const unusedTx = {} as TransactionContext;

void describe('readAllNotifications', () => {
  void it('locks Homes ascending then Memberships ascending before the update', async () => {
    const order: string[] = [];
    await readAllNotifications(
      { userId: USER },
      {
        notifications: {
          readTransactionTimestamp() {
            order.push('timestamp');
            return Promise.resolve(READ_THROUGH);
          },
          findActiveRecipientTenures() {
            order.push('tenures');
            return Promise.resolve([
              { homeId: HOME_B, membershipId: MEMBER_B },
              { homeId: HOME_A, membershipId: MEMBER_A },
            ]);
          },
          readAllEligibleUnread(_tx, input) {
            order.push(`update:${input.readThrough.toISOString()}`);
            return Promise.resolve();
          },
        },
        lockHomeForUpdate(_tx, homeId) {
          order.push(`home:${homeId}`);
          return Promise.resolve();
        },
        lockMembershipForUpdate(_tx, membershipId) {
          order.push(`membership:${membershipId}`);
          return Promise.resolve();
        },
        runRepeatableRead: (work) => work(unusedTx),
      },
    );
    assert.deepEqual(order, [
      'timestamp',
      'tenures',
      `home:${HOME_A}`,
      `home:${HOME_B}`,
      `membership:${MEMBER_A}`,
      `membership:${MEMBER_B}`,
      `update:${READ_THROUGH.toISOString()}`,
    ]);
  });

  void it('retries a serialization failure with a new transaction and readThrough', async () => {
    let attempts = 0;
    const timestamps = [
      new Date('2026-09-13T18:00:00.000Z'),
      new Date('2026-09-13T18:00:01.000Z'),
    ];
    const seen: string[] = [];
    await readAllNotifications(
      { userId: USER },
      {
        notifications: {
          readTransactionTimestamp() {
            const readThrough = timestamps[attempts];
            attempts += 1;
            if (readThrough === undefined) {
              throw new Error('unexpected extra timestamp');
            }
            seen.push(readThrough.toISOString());
            return Promise.resolve(readThrough);
          },
          findActiveRecipientTenures: () => Promise.resolve([]),
          readAllEligibleUnread(_tx, input) {
            if (attempts === 1) {
              const error = Object.assign(new Error('could not serialize'), {
                code: '40001',
              });
              throw error;
            }
            seen.push(`updated:${input.readThrough.toISOString()}`);
            return Promise.resolve();
          },
        },
        lockHomeForUpdate: () => Promise.resolve(),
        lockMembershipForUpdate: () => Promise.resolve(),
        runRepeatableRead: (work) => work(unusedTx),
      },
    );
    assert.equal(attempts, 2);
    assert.deepEqual(seen, [
      '2026-09-13T18:00:00.000Z',
      '2026-09-13T18:00:01.000Z',
      'updated:2026-09-13T18:00:01.000Z',
    ]);
  });
});
