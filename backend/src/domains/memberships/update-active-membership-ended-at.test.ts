import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL,
  createMembershipEndingWriter,
} from './update-active-membership-ended-at.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');

type QueryCall = { sql: string; values: unknown[] };

function fakeTx(
  calls: QueryCall[],
  options: { rowCount?: number | null; error?: Error } = {},
): TransactionContext {
  return {
    query(sql, values) {
      calls.push({ sql, values: values === undefined ? [] : [...values] });
      if (options.error) {
        return Promise.reject(options.error);
      }
      return Promise.resolve({
        rows: [],
        rowCount: options.rowCount ?? 1,
      });
    },
  };
}

void describe('update active membership ended_at', () => {
  void it('scopes the UPDATE to exact id, home, and active tenure', () => {
    assert.match(UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL, /SET ended_at = \$1/);
    assert.match(UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL, /WHERE id = \$2/);
    assert.match(UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL, /AND home_id = \$3/);
    assert.match(UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL, /AND ended_at IS NULL/);
    assert.doesNotMatch(UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL, /user_id/);
    assert.doesNotMatch(UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL, /DELETE/i);
    assert.doesNotMatch(UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL, /SET role/i);
    assert.doesNotMatch(
      UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL,
      /SET joined_at/i,
    );
  });

  void it('passes the exact tenure and command timestamp', async () => {
    const calls: QueryCall[] = [];
    const writer = createMembershipEndingWriter();
    const updated = await writer.endActiveMembership(fakeTx(calls), {
      membershipId: MEMBERSHIP,
      homeId: HOME,
      endedAt: ENDED_AT,
    });

    assert.equal(updated, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.sql, UPDATE_ACTIVE_MEMBERSHIP_ENDED_AT_SQL);
    assert.deepEqual(calls[0]?.values, [ENDED_AT, MEMBERSHIP, HOME]);
  });

  void it('returns zero when the driver reports no row', async () => {
    const writer = createMembershipEndingWriter();
    const updated = await writer.endActiveMembership(
      fakeTx([], { rowCount: 0 }),
      {
        membershipId: MEMBERSHIP,
        homeId: HOME,
        endedAt: ENDED_AT,
      },
    );
    assert.equal(updated, 0);
  });

  void it('does not expose database errors', async () => {
    const writer = createMembershipEndingWriter();
    await assert.rejects(
      () =>
        writer.endActiveMembership(
          fakeTx([], { error: new Error('UPDATE memberships failed') }),
          {
            membershipId: MEMBERSHIP,
            homeId: HOME,
            endedAt: ENDED_AT,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof TransactionInfrastructureError);
        assert.equal(error.message.includes('UPDATE'), false);
        assert.equal(error.message.includes('memberships'), false);
        return true;
      },
    );
  });
});
