import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  decideHousePulseRead,
  isHousePulseReadCapableRole,
} from './list-policy.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function actor(
  role: ActiveHomeActor['role'],
): Pick<ActiveHomeActor, 'homeId' | 'role'> {
  return { homeId: HOME, role };
}

void describe('decideHousePulseRead', () => {
  void it('allows active Roommate and Admin for the same Home', () => {
    assert.equal(
      decideHousePulseRead({ actor: actor('ROOMMATE'), targetHomeId: HOME })
        .allowed,
      true,
    );
    assert.equal(
      decideHousePulseRead({ actor: actor('ADMIN'), targetHomeId: HOME })
        .allowed,
      true,
    );
    assert.equal(isHousePulseReadCapableRole('ROOMMATE'), true);
    assert.equal(isHousePulseReadCapableRole('ADMIN'), true);
  });

  void it('denies a Home-scope mismatch without a role exception', () => {
    const denied = decideHousePulseRead({
      actor: actor('ADMIN'),
      targetHomeId: OTHER,
    });
    assert.equal(denied.allowed, false);
    if (!denied.allowed) {
      assert.equal(denied.reason, 'HOME_SCOPE_MISMATCH');
    }
  });
});
