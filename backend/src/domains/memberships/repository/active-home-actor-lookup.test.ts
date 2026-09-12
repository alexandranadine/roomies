import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { AuthorizationIntegrityError } from '../../../platform/authz/errors.js';
import {
  ACTIVE_HOME_ACTOR_LOOKUP_SQL,
  lookupActiveHomeActor,
} from './active-home-actor-lookup.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type QueryCall = { sql: string; params: unknown[] };

function stubPool(
  rows: unknown[],
  calls: QueryCall[],
  queryError?: Error,
): Pool {
  return {
    query: (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (queryError) {
        return Promise.reject(queryError);
      }
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;
}

void describe('lookupActiveHomeActor', () => {
  void it('uses one Home-scoped parameterized lookup', async () => {
    const calls: QueryCall[] = [];
    const actor = await lookupActiveHomeActor(
      stubPool(
        [
          {
            id: MEMBERSHIP_ID,
            user_id: USER_ID,
            home_id: HOME_ID,
            role: 'ROOMMATE',
          },
        ],
        calls,
      ),
      { userId: USER_ID, homeId: HOME_ID },
    );

    assert.deepEqual(actor, {
      userId: USER_ID,
      membershipId: MEMBERSHIP_ID,
      homeId: HOME_ID,
      role: 'ROOMMATE',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.sql, ACTIVE_HOME_ACTOR_LOOKUP_SQL);
    assert.deepEqual(calls[0]?.params, [USER_ID, HOME_ID]);
    assert.match(ACTIVE_HOME_ACTOR_LOOKUP_SQL, /m\.user_id = \$1/);
    assert.match(ACTIVE_HOME_ACTOR_LOOKUP_SQL, /m\.home_id = \$2/);
    assert.match(ACTIVE_HOME_ACTOR_LOOKUP_SQL, /m\.ended_at IS NULL/);
    assert.match(ACTIVE_HOME_ACTOR_LOOKUP_SQL, /h\.archived_at IS NULL/);
    assert.doesNotMatch(ACTIVE_HOME_ACTOR_LOOKUP_SQL, /ORDER BY/i);
  });

  void it('returns null when no active Membership/Home row exists', async () => {
    const actor = await lookupActiveHomeActor(stubPool([], []), {
      userId: USER_ID,
      homeId: HOME_ID,
    });
    assert.equal(actor, null);
  });

  void it('fails closed on multiple active rows', async () => {
    await assert.rejects(
      () =>
        lookupActiveHomeActor(
          stubPool(
            [
              {
                id: MEMBERSHIP_ID,
                user_id: USER_ID,
                home_id: HOME_ID,
                role: 'ROOMMATE',
              },
              {
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                user_id: USER_ID,
                home_id: HOME_ID,
                role: 'ADMIN',
              },
            ],
            [],
          ),
          { userId: USER_ID, homeId: HOME_ID },
        ),
      AuthorizationIntegrityError,
    );
  });

  void it('fails closed on an invalid role', async () => {
    await assert.rejects(
      () =>
        lookupActiveHomeActor(
          stubPool(
            [
              {
                id: MEMBERSHIP_ID,
                user_id: USER_ID,
                home_id: HOME_ID,
                role: 'OWNER',
              },
            ],
            [],
          ),
          { userId: USER_ID, homeId: HOME_ID },
        ),
      AuthorizationIntegrityError,
    );
  });

  void it('does not expose database errors', async () => {
    await assert.rejects(
      () =>
        lookupActiveHomeActor(
          stubPool([], [], new Error('SELECT * FROM memberships failed')),
          { userId: USER_ID, homeId: HOME_ID },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AuthorizationIntegrityError);
        assert.equal(error.message.includes('SELECT'), false);
        assert.equal(error.message.includes('memberships'), false);
        return true;
      },
    );
  });
});
