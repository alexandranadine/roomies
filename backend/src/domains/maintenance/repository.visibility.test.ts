import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DELETE_AUTHORED_MAINTENANCE_SOURCE_SQL,
  DELETE_MAINTENANCE_AUDIENCE_FOR_ERASED_SOURCE_SQL,
  FIND_VISIBLE_MAINTENANCE_ENTRY_SQL,
  LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL,
  LOCK_AUTHORED_MAINTENANCE_SOURCES_FOR_ERASE_SQL,
  LOCK_VISIBLE_MAINTENANCE_ENTRY_FOR_RESOLVE_SQL,
  MAINTENANCE_ACTOR_SCOPE_SQL,
  MAINTENANCE_VISIBLE_PREDICATE_SQL,
  RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL,
} from './repository.js';

function assertActorScope(sql: string): void {
  assert.match(sql, /memberships\.home_id = \$1::uuid/);
  assert.match(sql, /memberships\.id = \$2::uuid/);
  assert.match(sql, /memberships\.ended_at IS NULL/);
  assert.match(sql, /homes\.id = \$1::uuid/);
  assert.match(sql, /homes\.archived_at IS NULL/);
}

function assertVisiblePredicate(sql: string): void {
  assert.match(sql, /e\.visibility = 'HOUSEHOLD'/);
  assert.match(sql, /e\.visibility = 'PRIVATE'/);
  assert.match(sql, /EXISTS \(/);
  assert.match(sql, /FROM maintenance_audiences a/);
  assert.match(sql, /a\.home_id = e\.home_id/);
  assert.match(sql, /a\.maintenance_entry_id = e\.id/);
  assert.match(sql, /a\.membership_id = \$2::uuid/);
}

function assertNoBypass(sql: string): void {
  assert.doesNotMatch(sql, /created_by_membership_id = \$2/);
  assert.doesNotMatch(sql, /created_by_membership_id = :actor/);
  assert.doesNotMatch(sql, /user_id/);
  assert.doesNotMatch(sql, /\brole\b/);
  assert.doesNotMatch(sql, /ADMIN/);
}

void describe('canonical Maintenance visibility SQL', () => {
  void it('owns one actor-scope and visible-entries fragment', () => {
    assertActorScope(MAINTENANCE_ACTOR_SCOPE_SQL);
    assertVisiblePredicate(MAINTENANCE_VISIBLE_PREDICATE_SQL);
    assertNoBypass(MAINTENANCE_ACTOR_SCOPE_SQL);
    assertNoBypass(MAINTENANCE_VISIBLE_PREDICATE_SQL);
    assert.doesNotMatch(
      MAINTENANCE_ACTOR_SCOPE_SQL,
      /created_by_membership_id/,
    );
  });

  void it('reuses the fragment for direct lookup, lock, and list', () => {
    for (const sql of [
      FIND_VISIBLE_MAINTENANCE_ENTRY_SQL,
      LOCK_VISIBLE_MAINTENANCE_ENTRY_FOR_RESOLVE_SQL,
      LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL,
    ]) {
      assertActorScope(sql);
      assertVisiblePredicate(sql);
      assertNoBypass(sql);
      assert.match(sql, /e\.home_id = \$1::uuid/);
      assert.doesNotMatch(sql, /UNION/);
    }
    assert.match(FIND_VISIBLE_MAINTENANCE_ENTRY_SQL, /e\.id = \$3::uuid/);
    assert.doesNotMatch(FIND_VISIBLE_MAINTENANCE_ENTRY_SQL, /FOR UPDATE/);
    assert.match(
      LOCK_VISIBLE_MAINTENANCE_ENTRY_FOR_RESOLVE_SQL,
      /FOR UPDATE OF e/,
    );
    assert.match(
      LOCK_VISIBLE_MAINTENANCE_ENTRY_FOR_RESOLVE_SQL,
      /INNER JOIN maintenance_entries e/,
    );
  });

  void it('conditionally resolves only the complete OPEN matrix', () => {
    assert.match(
      RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL,
      /UPDATE maintenance_entries/,
    );
    assert.match(RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL, /home_id = \$1::uuid/);
    assert.match(RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL, /id = \$2::uuid/);
    assert.match(RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL, /AND status = 'OPEN'/);
    assert.match(
      RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL,
      /resolved_by_membership_id IS NULL/,
    );
    assert.match(RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL, /resolved_at IS NULL/);
    assert.match(RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL, /status = 'RESOLVED'/);
    assert.doesNotMatch(RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL, /reopen/i);
    assert.doesNotMatch(RESOLVE_OPEN_MAINTENANCE_ENTRY_SQL, /user_id/);
  });

  void it('locks authored sources by exact membership without Home or content', () => {
    assert.match(
      LOCK_AUTHORED_MAINTENANCE_SOURCES_FOR_ERASE_SQL,
      /created_by_membership_id = ANY\(\$1::uuid\[\]\)/,
    );
    assert.match(
      LOCK_AUTHORED_MAINTENANCE_SOURCES_FOR_ERASE_SQL,
      /ORDER BY home_id ASC, id ASC/,
    );
    assert.match(LOCK_AUTHORED_MAINTENANCE_SOURCES_FOR_ERASE_SQL, /FOR UPDATE/);
    assert.doesNotMatch(
      LOCK_AUTHORED_MAINTENANCE_SOURCES_FOR_ERASE_SQL,
      /title/,
    );
    assert.doesNotMatch(
      LOCK_AUTHORED_MAINTENANCE_SOURCES_FOR_ERASE_SQL,
      /details/,
    );
    assert.doesNotMatch(
      LOCK_AUTHORED_MAINTENANCE_SOURCES_FOR_ERASE_SQL,
      /user_id/,
    );
    assert.doesNotMatch(
      LOCK_AUTHORED_MAINTENANCE_SOURCES_FOR_ERASE_SQL,
      /resolved_by_membership_id/,
    );
    assert.match(
      DELETE_MAINTENANCE_AUDIENCE_FOR_ERASED_SOURCE_SQL,
      /DELETE FROM maintenance_audiences/,
    );
    assert.match(
      DELETE_AUTHORED_MAINTENANCE_SOURCE_SQL,
      /DELETE FROM maintenance_entries/,
    );
  });
});
