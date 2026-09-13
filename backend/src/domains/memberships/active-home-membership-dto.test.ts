import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  toActiveHomeMembershipsDto,
  activeHomeMembershipsDtoSchema,
} from './active-home-membership-dto.js';

const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

void describe('toActiveHomeMembershipsDto', () => {
  void it('whitelists currentMembershipId and membershipId+name rows only', () => {
    const dto = toActiveHomeMembershipsDto({
      currentMembershipId: MEMBERSHIP_A,
      memberships: [
        { membershipId: MEMBERSHIP_A, name: 'Alex' },
        { membershipId: MEMBERSHIP_B, name: 'Jamie' },
      ],
    });
    assert.deepEqual(dto, {
      currentMembershipId: MEMBERSHIP_A,
      memberships: [
        { membershipId: MEMBERSHIP_A, name: 'Alex' },
        { membershipId: MEMBERSHIP_B, name: 'Jamie' },
      ],
    });
    assert.deepEqual(Object.keys(dto).sort(), [
      'currentMembershipId',
      'memberships',
    ]);
    assert.deepEqual(Object.keys(dto.memberships[0]!).sort(), [
      'membershipId',
      'name',
    ]);
    assert.equal(activeHomeMembershipsDtoSchema.safeParse(dto).success, true);
  });

  void it('rejects leaked identity fields', () => {
    const leaked = {
      currentMembershipId: MEMBERSHIP_A,
      memberships: [
        {
          membershipId: MEMBERSHIP_A,
          name: 'Alex',
          userId: '11111111-1111-4111-8111-111111111111',
          email: 'alex@example.test',
          role: 'ADMIN',
        },
      ],
    };
    assert.equal(
      activeHomeMembershipsDtoSchema.safeParse(leaked).success,
      false,
    );
  });
});
