import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { LockedHomeStructure } from './locked-home-structure.js';
import { decideArchiveFinalMember, decideHomeRead } from './policies.js';

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

void describe('decideArchiveFinalMember', () => {
  function structure(
    role: 'ADMIN' | 'ROOMMATE',
    count = 1,
  ): LockedHomeStructure {
    const current = actor(role);
    return {
      home: { id: HOME_A },
      actor: current,
      activeMemberships: [
        {
          id: current.membershipId,
          userId: current.userId,
          homeId: current.homeId,
          role,
        },
        ...(count > 1
          ? [
              {
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                userId: '22222222-2222-4222-8222-222222222222',
                homeId: HOME_A,
                role: 'ADMIN' as const,
              },
            ]
          : []),
      ],
    };
  }

  void it('allows only the exact sole locked Admin', () => {
    assert.deepEqual(decideArchiveFinalMember(structure('ADMIN')), {
      allowed: true,
    });
  });

  void it('applies role denial before cardinality conflict', () => {
    assert.deepEqual(decideArchiveFinalMember(structure('ROOMMATE', 2)), {
      allowed: false,
      reason: 'ACTOR_NOT_ADMIN',
    });
    assert.deepEqual(decideArchiveFinalMember(structure('ADMIN', 2)), {
      allowed: false,
      reason: 'FINAL_MEMBER_REQUIRED',
    });
  });

  void it('rejects an impossible sole-tenure mismatch', () => {
    const input = structure('ADMIN');
    assert.deepEqual(
      decideArchiveFinalMember({
        ...input,
        activeMemberships: [
          {
            ...input.activeMemberships[0]!,
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          },
        ],
      }),
      { allowed: false, reason: 'SOLE_MEMBER_MISMATCH' },
    );
  });
});
