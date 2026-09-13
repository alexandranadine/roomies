import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  findLatestEndedMembershipTenure,
  insertInvitationMembership,
} from './invitation-acceptance-store.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';

void describe('invitation Membership acceptance store', () => {
  void it('selects the latest ended tenure with deterministic ordering', async () => {
    const queries: string[] = [];
    const endedAt = new Date('2026-10-01T00:00:00.000Z');
    const tx: TransactionContext = {
      query: <T>(text: string) => {
        queries.push(text);
        return Promise.resolve({
          rows: [
            {
              id: MEMBERSHIP_ID,
              role: 'ADMIN',
              joined_at: new Date('2026-01-01T00:00:00.000Z'),
              ended_at: endedAt,
            },
          ] as T[],
          rowCount: 1,
        });
      },
    };
    const tenure = await findLatestEndedMembershipTenure(tx, {
      homeId: HOME_ID,
      userId: USER_ID,
    });
    assert.equal(tenure?.id, MEMBERSHIP_ID);
    assert.equal(tenure?.role, 'ADMIN');
    assert.equal(tenure?.endedAt, endedAt);
    assert.match(queries[0] ?? '', /ended_at IS NOT NULL/);
    assert.match(queries[0] ?? '', /ORDER BY ended_at DESC, id DESC/);
    assert.doesNotMatch(queries[0] ?? '', /FOR UPDATE/);
  });

  void it('inserts a new ROOMMATE row with explicit joined_at and null ended_at', async () => {
    let sql = '';
    let values: readonly unknown[] = [];
    const tx: TransactionContext = {
      query: <T>(text: string, input?: readonly unknown[]) => {
        sql = text;
        values = input ?? [];
        return Promise.resolve({ rows: [] as T[], rowCount: 1 });
      },
    };
    const joinedAt = new Date('2026-10-02T00:00:00.000Z');
    await insertInvitationMembership(tx, {
      id: MEMBERSHIP_ID,
      homeId: HOME_ID,
      userId: USER_ID,
      joinedAt,
    });
    assert.match(sql, /INSERT INTO memberships/);
    assert.match(sql, /'ROOMMATE'/);
    assert.match(sql, /NULL/);
    assert.deepEqual(values, [MEMBERSHIP_ID, HOME_ID, USER_ID, joinedAt]);
    assert.doesNotMatch(sql, /UPDATE/);
  });
});
