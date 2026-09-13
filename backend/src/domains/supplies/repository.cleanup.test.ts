import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL } from './repository.js';

void describe('Supply membership-ending cleanup SQL', () => {
  void it('releases only active claims for the exact Home and Membership', () => {
    assert.match(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /UPDATE supply_claims/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /released_at = \$3::timestamptz/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /release_reason = 'MEMBERSHIP_ENDED'/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /updated_at = \$3::timestamptz/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /home_id = \$1::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /claimant_membership_id = \$2::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /released_at IS NULL/,
    );
    assert.doesNotMatch(RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL, /user_id/);
    assert.doesNotMatch(RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL, /DELETE /i);
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /claimant_membership_id = NULL/,
    );
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /WHERE\s+claimant_membership_id = \$/i,
    );
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /supply_entries/,
    );
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIMS_FOR_MEMBERSHIP_SQL,
      /VOLUNTARY_LEAVE|ADMIN_REMOVAL|HOME_ARCHIVED|ENTRY_CANCELED/,
    );
  });
});
