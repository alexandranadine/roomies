import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
  TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
  TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
} from './repository.js';

void describe('Supply terminalization SQL', () => {
  void it('releases an active claim without a claimant Membership predicate', () => {
    assert.match(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /UPDATE supply_claims/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /id = \$1::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /home_id = \$2::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /supply_entry_id = \$3::uuid/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /released_at IS NULL/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /release_reason IS NULL/,
    );
    assert.match(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /release_reason = \$5/,
    );
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /claimant_membership_id =/,
    );
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /user_id/,
    );
    assert.doesNotMatch(
      RELEASE_ACTIVE_CLAIM_FOR_ENTRY_TERMINALIZATION_SQL,
      /DELETE /i,
    );
  });

  void it('terminalizes OPEN entries as OBTAINED with the complete matrix', () => {
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
      /UPDATE supply_entries/,
    );
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
      /status = 'OBTAINED'/,
    );
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
      /obtained_at = \$3::timestamptz/,
    );
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
      /canceled_at = NULL/,
    );
    assert.match(TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL, /id = \$1::uuid/);
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
      /home_id = \$2::uuid/,
    );
    assert.match(TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL, /status = 'OPEN'/);
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
      /obtained_at IS NULL/,
    );
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL,
      /canceled_at IS NULL/,
    );
    assert.doesNotMatch(TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL, /user_id/);
    assert.doesNotMatch(TERMINALIZE_SUPPLY_ENTRY_AS_OBTAINED_SQL, /DELETE /i);
  });

  void it('terminalizes OPEN entries as CANCELED with the complete matrix', () => {
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
      /UPDATE supply_entries/,
    );
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
      /status = 'CANCELED'/,
    );
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
      /canceled_at = \$3::timestamptz/,
    );
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
      /obtained_at = NULL/,
    );
    assert.match(TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL, /id = \$1::uuid/);
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
      /home_id = \$2::uuid/,
    );
    assert.match(TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL, /status = 'OPEN'/);
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
      /obtained_at IS NULL/,
    );
    assert.match(
      TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL,
      /canceled_at IS NULL/,
    );
    assert.doesNotMatch(TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL, /user_id/);
    assert.doesNotMatch(TERMINALIZE_SUPPLY_ENTRY_AS_CANCELED_SQL, /DELETE /i);
  });
});
