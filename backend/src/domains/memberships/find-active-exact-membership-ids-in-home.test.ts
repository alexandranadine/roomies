import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
  findActiveExactMembershipIdsInHome,
} from './find-active-exact-membership-ids-in-home.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RECIPIENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FOREIGN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

void describe('findActiveExactMembershipIdsInHome', () => {
  void it('returns only requested active same-Home Membership IDs', async () => {
    const calls: { text: string; values: readonly unknown[] | undefined }[] =
      [];
    const tx: TransactionContext = {
      query<T = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) {
        calls.push({ text, values });
        return Promise.resolve({
          rows: [{ id: ACTOR }, { id: RECIPIENT }] as T[],
          rowCount: 2,
        });
      },
    };

    const found = await findActiveExactMembershipIdsInHome(tx, {
      homeId: HOME,
      membershipIds: [RECIPIENT, ACTOR, ACTOR],
    });
    assert.deepEqual(found, [ACTOR, RECIPIENT]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.text, FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL);
    assert.deepEqual(calls[0]?.values, [HOME, [ACTOR, RECIPIENT]]);
    assert.equal(
      FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL.includes('user_id'),
      false,
    );
    assert.equal(
      FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL.includes('role'),
      false,
    );
    assert.match(
      FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
      /m\.home_id = \$1::uuid/,
    );
    assert.match(
      FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
      /m\.id = ANY\(\$2::uuid\[\]\)/,
    );
    assert.match(
      FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
      /ended_at IS NULL/,
    );
    assert.doesNotMatch(
      FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL,
      /FOR UPDATE/i,
    );
    assert.doesNotMatch(FIND_ACTIVE_EXACT_MEMBERSHIP_IDS_IN_HOME_SQL, /homes/);
  });

  void it('returns an empty set when no requested IDs are active in the Home', async () => {
    const found = await findActiveExactMembershipIdsInHome(
      {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      },
      { homeId: HOME, membershipIds: [FOREIGN] },
    );
    assert.deepEqual(found, []);
  });

  void it('does not query when the requested set is empty', async () => {
    const found = await findActiveExactMembershipIdsInHome(
      {
        query: () => {
          throw new Error('unexpected query');
        },
      },
      { homeId: HOME, membershipIds: [] },
    );
    assert.deepEqual(found, []);
  });

  void it('conceals a mixed same-Home and foreign result as a subset', async () => {
    const found = await findActiveExactMembershipIdsInHome(
      {
        query<T = Record<string, unknown>>() {
          return Promise.resolve({
            rows: [{ id: ACTOR }] as T[],
            rowCount: 1,
          });
        },
      },
      { homeId: HOME, membershipIds: [ACTOR, FOREIGN] },
    );
    assert.deepEqual(found, [ACTOR]);
    assert.equal(found.includes(FOREIGN), false);
    assert.equal(found.includes(OTHER_HOME), false);
  });

  void it('fails closed when a row is outside the requested set', async () => {
    await assert.rejects(
      () =>
        findActiveExactMembershipIdsInHome(
          {
            query<T = Record<string, unknown>>() {
              return Promise.resolve({
                rows: [{ id: FOREIGN }] as T[],
                rowCount: 1,
              });
            },
          },
          { homeId: HOME, membershipIds: [ACTOR] },
        ),
      AuthorizationIntegrityError,
    );
  });

  void it('fails closed on a malformed Home or Membership id', async () => {
    const tx: TransactionContext = {
      query: () => Promise.reject(new Error('should not query')),
    };
    await assert.rejects(
      () =>
        findActiveExactMembershipIdsInHome(tx, {
          homeId: 'not-a-uuid',
          membershipIds: [ACTOR],
        }),
      AuthorizationIntegrityError,
    );
    await assert.rejects(
      () =>
        findActiveExactMembershipIdsInHome(tx, {
          homeId: HOME,
          membershipIds: ['bad'],
        }),
      AuthorizationIntegrityError,
    );
  });

  void it('fails closed when the lookup throws', async () => {
    await assert.rejects(
      () =>
        findActiveExactMembershipIdsInHome(
          {
            query: () => Promise.reject(new Error('lookup failed')),
          },
          { homeId: HOME, membershipIds: [ACTOR] },
        ),
      AuthorizationIntegrityError,
    );
  });
});
