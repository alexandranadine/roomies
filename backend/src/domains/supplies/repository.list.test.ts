import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LIST_OPEN_ENTRIES_BY_HOME_SQL,
  LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
  LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
} from './repository.js';

void describe('Supply list SQL', () => {
  void it('scopes every list by home_id and never joins claims', () => {
    for (const sql of [
      LIST_OPEN_ENTRIES_BY_HOME_SQL,
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
    ]) {
      assert.match(sql, /FROM supply_entries/);
      assert.match(sql, /home_id = \$1::uuid/);
      assert.doesNotMatch(sql, /supply_claims/);
      assert.doesNotMatch(sql, /JOIN/i);
      assert.doesNotMatch(sql, /DELETE /i);
    }
  });

  void it('orders OPEN rows by created_at ASC, id ASC', () => {
    assert.match(
      LIST_OPEN_ENTRIES_BY_HOME_SQL,
      /status = 'OPEN'[\s\S]*ORDER BY created_at ASC, id ASC/,
    );
  });

  void it('groups all-Home rows OPEN first, then terminal history', () => {
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN status = 'OPEN' THEN created_at END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN status = 'OPEN' THEN id END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN status <> 'OPEN' THEN updated_at END DESC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN status <> 'OPEN' THEN status END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_SQL,
      /CASE WHEN status <> 'OPEN' THEN id END DESC/,
    );
  });

  void it('orders a single status with OPEN vs terminal rules', () => {
    assert.match(LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL, /status = \$2/);
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
      /CASE WHEN status = 'OPEN' THEN created_at END ASC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
      /CASE WHEN status <> 'OPEN' THEN updated_at END DESC/,
    );
    assert.match(
      LIST_SUPPLY_ENTRIES_BY_HOME_AND_STATUS_SQL,
      /CASE WHEN status <> 'OPEN' THEN id END DESC/,
    );
  });
});
