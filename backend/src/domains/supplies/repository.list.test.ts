import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LIST_OPEN_ENTRIES_BY_HOME_SQL,
  LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
  LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
} from './repository.js';

void describe('Supply list SQL', () => {
  void it('scopes every list by home_id and joins only active claims', () => {
    for (const sql of [
      LIST_OPEN_ENTRIES_BY_HOME_SQL,
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
    ]) {
      assert.match(sql, /FROM supply_entries e/);
      assert.match(sql, /e\.home_id = \$1::uuid/);
      assert.match(sql, /LEFT JOIN supply_claims c/);
      assert.match(sql, /c\.home_id = e\.home_id/);
      assert.match(sql, /c\.supply_entry_id = e\.id/);
      assert.match(sql, /c\.released_at IS NULL/);
      assert.match(sql, /active_claimant_membership_id/);
      assert.match(sql, /active_claimed_at/);
      assert.doesNotMatch(sql, /c\.id AS/);
      assert.doesNotMatch(sql, /c\.home_id AS/);
      assert.doesNotMatch(sql, /release_reason/);
      assert.doesNotMatch(sql, /DELETE /i);
    }
  });

  void it('orders OPEN rows by created_at ASC, id ASC', () => {
    assert.match(
      LIST_OPEN_ENTRIES_BY_HOME_SQL,
      /e\.status = 'OPEN'[\s\S]*ORDER BY e\.created_at ASC, e\.id ASC/,
    );
  });

  void it('groups all-Home rows OPEN first, then terminal history', () => {
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN e\.status = 'OPEN' THEN 0 ELSE 1 END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN e\.status = 'OPEN' THEN e\.created_at END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN e\.status = 'OPEN' THEN e\.id END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN e\.status <> 'OPEN' THEN e\.updated_at END DESC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN e\.status <> 'OPEN' THEN e\.status END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN e\.status <> 'OPEN' THEN e\.id END DESC/,
    );
  });

  void it('orders a single status with OPEN vs terminal rules', () => {
    assert.match(LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL, /e\.status = \$2/);
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
      /CASE WHEN e\.status = 'OPEN' THEN e\.created_at END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
      /CASE WHEN e\.status <> 'OPEN' THEN e\.updated_at END DESC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
      /CASE WHEN e\.status <> 'OPEN' THEN e\.id END DESC/,
    );
  });
});
