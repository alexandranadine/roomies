import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeMembershipListItem } from '../../domains/memberships/active-home-membership-list.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
} from '../../platform/authz/errors.js';
import { listActiveHomeMemberships } from './list-active-home-memberships.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const actor: ActiveHomeActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  membershipId: MEMBERSHIP,
  homeId: HOME,
  role: 'ROOMMATE',
};

function row(
  overrides: Partial<ActiveHomeMembershipListItem> = {},
): ActiveHomeMembershipListItem {
  return {
    membershipId: MEMBERSHIP,
    name: 'Alex',
    ...overrides,
  };
}

void describe('listActiveHomeMemberships', () => {
  void it('returns the repository order including the caller and other active roles', async () => {
    const rows = [
      row({ membershipId: OTHER_MEMBERSHIP, name: 'Jamie' }),
      row(),
    ];
    const listed = await listActiveHomeMemberships(
      { actor, homeId: HOME },
      {
        listActiveByHome: (homeId) =>
          Promise.resolve(homeId === HOME ? rows : []),
      },
    );
    assert.equal(listed, rows);
    assert.deepEqual(
      listed.map((item) => item.membershipId),
      [OTHER_MEMBERSHIP, MEMBERSHIP],
    );
  });

  void it('lets an active Admin list through the same membership.list_active path', async () => {
    const listed = await listActiveHomeMemberships(
      { actor: { ...actor, role: 'ADMIN' }, homeId: HOME },
      { listActiveByHome: () => Promise.resolve([row()]) },
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.membershipId, MEMBERSHIP);
  });

  void it('preserves a reader-empty list only when the actor is still present', async () => {
    await assert.rejects(
      () =>
        listActiveHomeMemberships(
          { actor, homeId: HOME },
          { listActiveByHome: () => Promise.resolve([]) },
        ),
      AuthorizationIntegrityError,
    );
  });

  void it('conceals a Home-scope mismatch without reading Memberships', async () => {
    await assert.rejects(
      () =>
        listActiveHomeMemberships(
          { actor, homeId: OTHER_HOME },
          {
            listActiveByHome: () =>
              Promise.reject(new Error('must not list on policy deny')),
          },
        ),
      ConcealedNotFoundError,
    );
  });

  void it('does not pass userId into the reader', async () => {
    const calls: string[] = [];
    await listActiveHomeMemberships(
      { actor, homeId: HOME },
      {
        listActiveByHome: (homeId) => {
          calls.push(homeId);
          return Promise.resolve([row()]);
        },
      },
    );
    assert.deepEqual(calls, [HOME]);
  });
});
