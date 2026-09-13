import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  FIND_ACTIVE_HOME_MEMBERSHIP_SQL,
  findActiveHomeMembership,
} from './find-active-home-membership.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

void describe('findActiveHomeMembership', () => {
  void it('looks up exact Membership.id and Home.id without User.id', async () => {
    const calls: { text: string; values: readonly unknown[] | undefined }[] =
      [];
    const tx: TransactionContext = {
      query<T = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) {
        calls.push({ text, values });
        return Promise.resolve({
          rows: [{ id: MEMBERSHIP, home_id: HOME }] as T[],
          rowCount: 1,
        });
      },
    };

    const found = await findActiveHomeMembership(tx, {
      homeId: HOME,
      membershipId: MEMBERSHIP,
    });
    assert.deepEqual(found, { id: MEMBERSHIP, homeId: HOME });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.text, FIND_ACTIVE_HOME_MEMBERSHIP_SQL);
    assert.deepEqual(calls[0]?.values, [MEMBERSHIP, HOME]);
    assert.equal(FIND_ACTIVE_HOME_MEMBERSHIP_SQL.includes('user_id'), false);
    assert.match(FIND_ACTIVE_HOME_MEMBERSHIP_SQL, /m\.id = \$1/);
    assert.match(FIND_ACTIVE_HOME_MEMBERSHIP_SQL, /m\.home_id = \$2/);
    assert.match(FIND_ACTIVE_HOME_MEMBERSHIP_SQL, /ended_at IS NULL/);
    assert.match(FIND_ACTIVE_HOME_MEMBERSHIP_SQL, /archived_at IS NULL/);
  });

  void it('returns null when no active same-Home tenure exists', async () => {
    const found = await findActiveHomeMembership(
      {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      },
      { homeId: HOME, membershipId: MEMBERSHIP },
    );
    assert.equal(found, null);
  });

  void it('fails closed when two active rows appear', async () => {
    await assert.rejects(
      () =>
        findActiveHomeMembership(
          {
            query<T = Record<string, unknown>>() {
              return Promise.resolve({
                rows: [
                  { id: MEMBERSHIP, home_id: HOME },
                  { id: MEMBERSHIP, home_id: HOME },
                ] as T[],
                rowCount: 2,
              });
            },
          },
          { homeId: HOME, membershipId: MEMBERSHIP },
        ),
      AuthorizationIntegrityError,
    );
  });
});
