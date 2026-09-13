import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { insertActiveMembership } from './insert-active-membership.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';
const JOINED_AT = new Date('2026-09-12T00:00:00.000Z');

void describe('insertActiveMembership', () => {
  void it('inserts an ordinary active ADMIN tenure with null ended_at', async () => {
    let sql = '';
    let values: readonly unknown[] = [];
    const tx: TransactionContext = {
      query: <T>(text: string, input?: readonly unknown[]) => {
        sql = text;
        values = input ?? [];
        return Promise.resolve({ rows: [] as T[], rowCount: 1 });
      },
    };
    await insertActiveMembership(tx, {
      id: MEMBERSHIP_ID,
      homeId: HOME_ID,
      userId: USER_ID,
      role: 'ADMIN',
      joinedAt: JOINED_AT,
    });
    assert.match(sql, /INSERT INTO memberships/);
    assert.match(sql, /ended_at/);
    assert.match(sql, /NULL/);
    assert.doesNotMatch(sql, /founder|owner|primary_admin|created_by/i);
    assert.doesNotMatch(sql, /UPDATE/);
    assert.deepEqual(values, [
      MEMBERSHIP_ID,
      HOME_ID,
      USER_ID,
      'ADMIN',
      JOINED_AT,
    ]);
  });
});
