import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { getHome } from './get-home.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const actor: ActiveHomeActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  homeId: HOME_A,
  role: 'ROOMMATE',
};

void describe('getHome', () => {
  void it('returns the active Home after policy allow', async () => {
    const home = await getHome(
      { actor, homeId: HOME_A },
      {
        findActiveHomeById: (homeId) =>
          Promise.resolve({
            id: homeId,
            name: 'Oak Street',
            timezone: 'UTC',
          }),
      },
    );
    assert.deepEqual(home, {
      id: HOME_A,
      name: 'Oak Street',
      timezone: 'UTC',
    });
  });

  void it('conceals a Home-scope mismatch without reading persistence', async () => {
    await assert.rejects(
      () =>
        getHome(
          { actor, homeId: HOME_B },
          {
            findActiveHomeById: () =>
              Promise.reject(new Error('must not read Home on policy deny')),
          },
        ),
      ConcealedNotFoundError,
    );
  });

  void it('conceals an archive race when the final read misses', async () => {
    await assert.rejects(
      () =>
        getHome(
          { actor, homeId: HOME_A },
          { findActiveHomeById: () => Promise.resolve(null) },
        ),
      ConcealedNotFoundError,
    );
  });
});
