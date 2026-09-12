import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeActor } from './context.js';
import { isActorMembership, isHomeAdmin } from './home-role.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_MEMBERSHIP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function actor(overrides: Partial<ActiveHomeActor> = {}): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: NEW_MEMBERSHIP_ID,
    homeId: HOME_ID,
    role: 'ROOMMATE',
    ...overrides,
  };
}

void describe('isHomeAdmin', () => {
  void it('is true only for ADMIN', () => {
    assert.equal(isHomeAdmin(actor({ role: 'ADMIN' })), true);
    assert.equal(isHomeAdmin(actor({ role: 'ROOMMATE' })), false);
  });
});

void describe('isActorMembership', () => {
  void it('compares membershipId, not userId', () => {
    const current = actor({
      userId: USER_ID,
      membershipId: NEW_MEMBERSHIP_ID,
    });

    assert.equal(isActorMembership(current, NEW_MEMBERSHIP_ID), true);
    assert.equal(isActorMembership(current, OLD_MEMBERSHIP_ID), false);
    assert.equal(
      isActorMembership({ membershipId: OLD_MEMBERSHIP_ID }, OLD_MEMBERSHIP_ID),
      true,
    );
    assert.notEqual(current.userId, OLD_MEMBERSHIP_ID);
    assert.notEqual(current.userId, NEW_MEMBERSHIP_ID);
    assert.equal(current.userId, USER_ID);
  });
});
