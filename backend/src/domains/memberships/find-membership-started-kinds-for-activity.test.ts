import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MembershipActivitySourceIntegrityError } from './errors.js';
import {
  findMembershipStartedKindsForActivity,
  type MembershipStartedKindQueryable,
} from './find-membership-started-kinds-for-activity.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOINER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function queryable(
  rows: readonly { membership_id: string; created_home: boolean }[],
): MembershipStartedKindQueryable {
  return {
    query: async <T>() => ({ rows: [...rows] as T[] }),
  };
}

void describe('findMembershipStartedKindsForActivity', () => {
  void it('maps creator and joiner Membership starts from canonical timestamps', async () => {
    const kinds = await findMembershipStartedKindsForActivity(
      queryable([
        { membership_id: CREATOR, created_home: true },
        { membership_id: JOINER, created_home: false },
      ]),
      { homeId: HOME, membershipIds: [CREATOR, JOINER] },
    );
    assert.equal(kinds.get(CREATOR), 'HOME_CREATION');
    assert.equal(kinds.get(JOINER), 'JOINED');
  });

  void it('returns an empty map when no Membership ids are requested', async () => {
    const kinds = await findMembershipStartedKindsForActivity(queryable([]), {
      homeId: HOME,
      membershipIds: [],
    });
    assert.equal(kinds.size, 0);
  });

  void it('fails when a requested Membership is missing', async () => {
    await assert.rejects(
      () =>
        findMembershipStartedKindsForActivity(
          queryable([{ membership_id: CREATOR, created_home: true }]),
          { homeId: HOME, membershipIds: [CREATOR, JOINER] },
        ),
      MembershipActivitySourceIntegrityError,
    );
  });
});
