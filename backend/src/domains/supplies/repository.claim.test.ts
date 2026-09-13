import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_SUPPLY_CLAIM_UNIQUE_CONSTRAINT,
  LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL,
  LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL,
  RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
} from './repository.js';

void describe('Supply claim/release SQL', () => {
  void it('locks an exact Home SupplyEntry', () => {
    assert.match(LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL, /FROM supply_entries/);
    assert.match(LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL, /home_id = \$1::uuid/);
    assert.match(LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL, /id = \$2::uuid/);
    assert.match(LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL, /FOR UPDATE/);
    assert.doesNotMatch(LOCK_SUPPLY_ENTRY_BY_HOME_AND_ID_SQL, /pg_advisory/i);
  });

  void it('locks the active claim by exact Home and entry', () => {
    assert.match(LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL, /FROM supply_claims/);
    assert.match(LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL, /home_id = \$1::uuid/);
    assert.match(LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL, /supply_entry_id = \$2::uuid/);
    assert.match(LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL, /released_at IS NULL/);
    assert.match(LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL, /FOR UPDATE/);
    assert.doesNotMatch(LOCK_ACTIVE_CLAIM_BY_ENTRY_SQL, /user_id/);
  });

  void it('conditionally releases only the exact active owned claim', () => {
    assert.match(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /UPDATE supply_claims/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /release_reason = 'CLAIMANT_RELEASED'/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /id = \$1::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /home_id = \$2::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /supply_entry_id = \$3::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /claimant_membership_id = \$4::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /released_at IS NULL/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /release_reason IS NULL/,
    );
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /user_id/,
    );
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIM_OWNED_BY_MEMBERSHIP_SQL,
      /DELETE /i,
    );
  });

  void it('translates only the deployed one-active-claim constraint', () => {
    assert.equal(
      ACTIVE_SUPPLY_CLAIM_UNIQUE_CONSTRAINT,
      'supply_claims_one_active_per_entry_1e26d778',
    );
  });
});
