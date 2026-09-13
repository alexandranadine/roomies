import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { insertHome } from './insert-home.js';

const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const CREATED_AT = new Date('2026-09-12T00:00:00.000Z');

void describe('insertHome', () => {
  void it('inserts Home columns without Membership or Owner fields', async () => {
    let sql = '';
    let values: readonly unknown[] = [];
    const tx: TransactionContext = {
      query: <T>(text: string, input?: readonly unknown[]) => {
        sql = text;
        values = input ?? [];
        return Promise.resolve({ rows: [] as T[], rowCount: 1 });
      },
    };
    await insertHome(tx, {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'America/Los_Angeles',
      createdAt: CREATED_AT,
    });
    assert.match(sql, /INSERT INTO homes/);
    assert.match(sql, /created_at/);
    assert.match(sql, /updated_at/);
    assert.doesNotMatch(sql, /memberships/i);
    assert.doesNotMatch(sql, /owner|created_by|primary_admin|founder/i);
    assert.deepEqual(values, [
      HOME_ID,
      'Oak Street',
      'America/Los_Angeles',
      CREATED_AT,
    ]);
  });
});
