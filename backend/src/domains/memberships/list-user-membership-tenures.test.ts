import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  LIST_USER_MEMBERSHIP_TENURES_SQL,
  listUserMembershipTenures,
  MembershipTenureDiscoveryIntegrityError,
} from './list-user-membership-tenures.js';

const USER = '11111111-1111-4111-8111-111111111111';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ENDED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_ACTIVE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENDED_AT = new Date('2026-06-01T00:00:00.000Z');

void describe('listUserMembershipTenures', () => {
  void it('lists every tenure for the User without locking or collapsing rejoins', async () => {
    const calls: { text: string; values: readonly unknown[] | undefined }[] =
      [];
    const tx: TransactionContext = {
      query<T = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) {
        calls.push({ text, values });
        return Promise.resolve({
          rows: [
            { id: MEMBERSHIP_ENDED, home_id: HOME_A, ended_at: ENDED_AT },
            { id: MEMBERSHIP_ACTIVE, home_id: HOME_A, ended_at: null },
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              home_id: HOME_B,
              ended_at: null,
            },
          ] as T[],
          rowCount: 3,
        });
      },
    };

    const tenures = await listUserMembershipTenures(tx, USER);
    assert.equal(tenures.length, 3);
    assert.deepEqual(tenures[0], {
      membershipId: MEMBERSHIP_ENDED,
      homeId: HOME_A,
      endedAt: ENDED_AT,
    });
    assert.deepEqual(tenures[1], {
      membershipId: MEMBERSHIP_ACTIVE,
      homeId: HOME_A,
      endedAt: null,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.text, LIST_USER_MEMBERSHIP_TENURES_SQL);
    assert.deepEqual(calls[0]?.values, [USER]);
    assert.match(LIST_USER_MEMBERSHIP_TENURES_SQL, /user_id = \$1::uuid/);
    assert.match(
      LIST_USER_MEMBERSHIP_TENURES_SQL,
      /ORDER BY home_id ASC, id ASC/,
    );
    assert.equal(
      LIST_USER_MEMBERSHIP_TENURES_SQL.includes('FOR UPDATE'),
      false,
    );
    assert.equal(
      LIST_USER_MEMBERSHIP_TENURES_SQL.includes('ended_at IS NULL'),
      false,
    );
  });

  void it('returns an empty list when the User has no Memberships', async () => {
    const tenures = await listUserMembershipTenures(
      {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      },
      USER,
    );
    assert.deepEqual(tenures, []);
  });

  void it('fails closed on a malformed userId or duplicate membership id', async () => {
    await assert.rejects(
      () =>
        listUserMembershipTenures(
          { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
          'not-a-uuid',
        ),
      MembershipTenureDiscoveryIntegrityError,
    );
    await assert.rejects(
      () =>
        listUserMembershipTenures(
          {
            query<T = Record<string, unknown>>() {
              return Promise.resolve({
                rows: [
                  { id: MEMBERSHIP_ACTIVE, home_id: HOME_A, ended_at: null },
                  { id: MEMBERSHIP_ACTIVE, home_id: HOME_B, ended_at: null },
                ] as T[],
                rowCount: 2,
              });
            },
          },
          USER,
        ),
      MembershipTenureDiscoveryIntegrityError,
    );
  });

  void it('maps query failure to transaction infrastructure without leaking SQL', async () => {
    await assert.rejects(
      () =>
        listUserMembershipTenures(
          {
            query: () => Promise.reject(new Error('SELECT boom')),
          },
          USER,
        ),
      TransactionInfrastructureError,
    );
  });
});
