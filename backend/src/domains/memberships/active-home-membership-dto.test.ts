import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  toActiveHomeMembershipsDto,
  activeHomeMembershipsDtoSchema,
} from './active-home-membership-dto.js';

const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

void describe('toActiveHomeMembershipsDto', () => {
  void it('whitelists currentMembershipId and membershipId+name+role rows', () => {
    const dto = toActiveHomeMembershipsDto({
      currentMembershipId: MEMBERSHIP_A,
      memberships: [
        { membershipId: MEMBERSHIP_A, name: 'Alex', role: 'ADMIN' },
        { membershipId: MEMBERSHIP_B, name: 'Jamie', role: 'ROOMMATE' },
      ],
    });
    assert.deepEqual(dto, {
      currentMembershipId: MEMBERSHIP_A,
      memberships: [
        { membershipId: MEMBERSHIP_A, name: 'Alex', role: 'ADMIN' },
        { membershipId: MEMBERSHIP_B, name: 'Jamie', role: 'ROOMMATE' },
      ],
    });
    assert.deepEqual(Object.keys(dto).sort(), [
      'currentMembershipId',
      'memberships',
    ]);
    assert.deepEqual(Object.keys(dto.memberships[0]!).sort(), [
      'membershipId',
      'name',
      'role',
    ]);
    assert.equal(activeHomeMembershipsDtoSchema.safeParse(dto).success, true);
  });

  void it('serializes ADMIN and ROOMMATE from the Membership row', () => {
    const dto = toActiveHomeMembershipsDto({
      currentMembershipId: MEMBERSHIP_A,
      memberships: [
        { membershipId: MEMBERSHIP_A, name: 'Alex', role: 'ADMIN' },
        { membershipId: MEMBERSHIP_B, name: 'Jamie', role: 'ROOMMATE' },
      ],
    });
    assert.equal(dto.memberships[0]?.role, 'ADMIN');
    assert.equal(dto.memberships[1]?.role, 'ROOMMATE');
  });

  void it('rejects leaked identity fields', () => {
    const leaked = {
      currentMembershipId: MEMBERSHIP_A,
      memberships: [
        {
          membershipId: MEMBERSHIP_A,
          name: 'Alex',
          role: 'ADMIN',
          userId: '11111111-1111-4111-8111-111111111111',
          email: 'alex@example.test',
        },
      ],
    };
    assert.equal(
      activeHomeMembershipsDtoSchema.safeParse(leaked).success,
      false,
    );
  });

  void it('rejects a missing role', () => {
    assert.equal(
      activeHomeMembershipsDtoSchema.safeParse({
        currentMembershipId: MEMBERSHIP_A,
        memberships: [{ membershipId: MEMBERSHIP_A, name: 'Alex' }],
      }).success,
      false,
    );
  });
});
