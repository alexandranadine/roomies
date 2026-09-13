import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import type { ActiveHomeSummary } from './active-home-summary.js';
import {
  assertUniqueActiveHomeIds,
  listActiveHomesForUser,
} from './list-active-homes.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function home(
  id: string,
  name: string,
  role: ActiveHomeSummary['role'] = 'ROOMMATE',
): ActiveHomeSummary {
  return { id, name, timezone: 'UTC', role };
}

void describe('assertUniqueActiveHomeIds', () => {
  void it('allows distinct Homes', () => {
    assert.doesNotThrow(() =>
      assertUniqueActiveHomeIds([home(HOME_A, 'A'), home(HOME_B, 'B')]),
    );
  });

  void it('fails closed on duplicate active Home rows', () => {
    assert.throws(
      () =>
        assertUniqueActiveHomeIds([
          home(HOME_A, 'Oak', 'ADMIN'),
          home(HOME_A, 'Oak', 'ROOMMATE'),
        ]),
      AuthorizationIntegrityError,
    );
  });
});

void describe('listActiveHomesForUser', () => {
  void it('returns the reader projection for the canonical User', async () => {
    const rows = [home(HOME_A, 'Oak', 'ADMIN')];
    const listed = await listActiveHomesForUser(
      { userId: USER_ID },
      {
        listActiveHomesForUser: (userId) => {
          assert.equal(userId, USER_ID);
          return Promise.resolve(rows);
        },
      },
    );
    assert.deepEqual(listed, rows);
  });

  void it('does not pick an arbitrary tenure when the same Home appears twice', async () => {
    await assert.rejects(
      () =>
        listActiveHomesForUser(
          { userId: USER_ID },
          {
            listActiveHomesForUser: () =>
              Promise.resolve([home(HOME_A, 'Oak'), home(HOME_A, 'Oak')]),
          },
        ),
      AuthorizationIntegrityError,
    );
  });
});
