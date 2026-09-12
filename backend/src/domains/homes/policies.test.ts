import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { decideHomeRead } from './policies.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function actor(role: ActiveHomeActor['role']): ActiveHomeActor {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    homeId: HOME_A,
    role,
  };
}

void describe('decideHomeRead', () => {
  void it('allows the same Home for ROOMMATE and ADMIN', () => {
    assert.deepEqual(
      decideHomeRead({ actor: actor('ROOMMATE'), targetHomeId: HOME_A }),
      {
        allowed: true,
      },
    );
    assert.deepEqual(
      decideHomeRead({ actor: actor('ADMIN'), targetHomeId: HOME_A }),
      {
        allowed: true,
      },
    );
  });

  void it('denies a Home-scope mismatch without inspecting role', () => {
    assert.deepEqual(
      decideHomeRead({ actor: actor('ADMIN'), targetHomeId: HOME_B }),
      {
        allowed: false,
        reason: 'HOME_SCOPE_MISMATCH',
      },
    );
    assert.deepEqual(
      decideHomeRead({ actor: actor('ROOMMATE'), targetHomeId: HOME_B }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
  });
});
