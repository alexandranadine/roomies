import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVITY_ACTOR_SCOPE_SQL,
  ACTIVITY_SOURCE_OUTBOX_EVENT_UNIQUE_CONSTRAINT,
  ACTIVITY_VISIBLE_PREDICATE_SQL,
  FIND_ACTIVITY_BY_SOURCE_OUTBOX_EVENT_ID_SQL,
  FIND_VISIBLE_ACTIVITY_SQL,
  LIST_VISIBLE_ACTIVITIES_SQL,
  LIST_VISIBLE_ACTIVITY_PAGE_SQL,
} from './repository.js';

function assertActorScope(sql: string): void {
  assert.match(sql, /memberships\.home_id = \$1::uuid/);
  assert.match(sql, /memberships\.id = \$2::uuid/);
  assert.match(sql, /memberships\.ended_at IS NULL/);
  assert.match(sql, /homes\.id = \$1::uuid/);
  assert.match(sql, /homes\.archived_at IS NULL/);
}

function assertVisiblePredicate(sql: string): void {
  assert.match(sql, /a\.visibility_class = 'HOME_VISIBLE'/);
  assert.match(sql, /a\.visibility_class = 'SOURCE_AUTHORIZED'/);
  assert.match(sql, /EXISTS \(/);
  assert.match(sql, /FROM activity_recipients r/);
  assert.match(sql, /r\.home_id = a\.home_id/);
  assert.match(sql, /r\.activity_id = a\.id/);
  assert.match(sql, /r\.membership_id = \$2::uuid/);
}

function assertNoBypass(sql: string): void {
  assert.doesNotMatch(sql, /user_id/);
  assert.doesNotMatch(sql, /\brole\b/);
  assert.doesNotMatch(sql, /ADMIN/);
  assert.doesNotMatch(sql, /PUBLIC|PRIVATE|HOUSEHOLD/);
}

void describe('canonical Activity visibility SQL', () => {
  void it('owns one actor-scope and visible-activity fragment', () => {
    assertActorScope(ACTIVITY_ACTOR_SCOPE_SQL);
    assertVisiblePredicate(ACTIVITY_VISIBLE_PREDICATE_SQL);
    assertNoBypass(ACTIVITY_ACTOR_SCOPE_SQL);
    assertNoBypass(ACTIVITY_VISIBLE_PREDICATE_SQL);
  });

  void it('reuses the fragment for lookup and list before cursor/order/limit', () => {
    for (const sql of [
      FIND_VISIBLE_ACTIVITY_SQL,
      LIST_VISIBLE_ACTIVITIES_SQL,
      LIST_VISIBLE_ACTIVITY_PAGE_SQL,
    ]) {
      assertActorScope(sql);
      assertVisiblePredicate(sql);
      assertNoBypass(sql);
      assert.match(sql, /a\.home_id = \$1::uuid/);
      assert.doesNotMatch(sql, /UNION/);
    }
    assert.match(FIND_VISIBLE_ACTIVITY_SQL, /a\.id = \$3::uuid/);
    assert.doesNotMatch(FIND_VISIBLE_ACTIVITY_SQL, /FOR UPDATE/);
    assert.match(LIST_VISIBLE_ACTIVITIES_SQL, /WITH actor_scope AS/);
    assert.match(LIST_VISIBLE_ACTIVITIES_SQL, /visible_activities AS/);
    assert.match(LIST_VISIBLE_ACTIVITIES_SQL, /a\.occurred_at DESC/);
    assert.match(LIST_VISIBLE_ACTIVITIES_SQL, /a\.id DESC/);
    assert.match(
      LIST_VISIBLE_ACTIVITIES_SQL,
      /FROM actor_scope\s+LEFT JOIN visible_activities ON TRUE/,
    );
    assert.doesNotMatch(LIST_VISIBLE_ACTIVITIES_SQL, /OFFSET/);
    assert.doesNotMatch(LIST_VISIBLE_ACTIVITIES_SQL, /COUNT\(\*\)/);
    assert.match(LIST_VISIBLE_ACTIVITY_PAGE_SQL, /WITH actor_scope AS/);
    assert.match(LIST_VISIBLE_ACTIVITY_PAGE_SQL, /visible_activities AS/);
    assert.match(
      LIST_VISIBLE_ACTIVITY_PAGE_SQL,
      /ACTIVITY_VISIBLE_PREDICATE_SQL|visibility_class = 'HOME_VISIBLE'/,
    );
    assert.match(
      LIST_VISIBLE_ACTIVITY_PAGE_SQL,
      /a\.occurred_at < \$3::timestamptz/,
    );
    assert.match(LIST_VISIBLE_ACTIVITY_PAGE_SQL, /a\.id < \$4::uuid/);
    assert.match(LIST_VISIBLE_ACTIVITY_PAGE_SQL, /a\.occurred_at DESC/);
    assert.match(LIST_VISIBLE_ACTIVITY_PAGE_SQL, /a\.id DESC/);
    assert.match(LIST_VISIBLE_ACTIVITY_PAGE_SQL, /LIMIT \$5/);
    assert.doesNotMatch(LIST_VISIBLE_ACTIVITY_PAGE_SQL, /OFFSET/);
    assert.doesNotMatch(LIST_VISIBLE_ACTIVITY_PAGE_SQL, /COUNT\(\*\)/);
    const pageVisibility = LIST_VISIBLE_ACTIVITY_PAGE_SQL.indexOf(
      "a.visibility_class = 'HOME_VISIBLE'",
    );
    const pageCursor = LIST_VISIBLE_ACTIVITY_PAGE_SQL.indexOf(
      'a.occurred_at < $3::timestamptz',
    );
    const pageOrder =
      LIST_VISIBLE_ACTIVITY_PAGE_SQL.indexOf('a.occurred_at DESC');
    const pageLimit = LIST_VISIBLE_ACTIVITY_PAGE_SQL.indexOf('LIMIT $5');
    assert.ok(pageVisibility >= 0 && pageCursor > pageVisibility);
    assert.ok(pageOrder > pageCursor);
    assert.ok(pageLimit > pageOrder);
  });

  void it('looks up by exact source outbox event without visibility filtering', () => {
    assert.match(
      FIND_ACTIVITY_BY_SOURCE_OUTBOX_EVENT_ID_SQL,
      /FROM activities/,
    );
    assert.match(
      FIND_ACTIVITY_BY_SOURCE_OUTBOX_EVENT_ID_SQL,
      /source_outbox_event_id = \$1::uuid/,
    );
    assert.doesNotMatch(FIND_ACTIVITY_BY_SOURCE_OUTBOX_EVENT_ID_SQL, /user_id/);
    assert.doesNotMatch(
      FIND_ACTIVITY_BY_SOURCE_OUTBOX_EVENT_ID_SQL,
      /activity_recipients/,
    );
  });

  void it('translates only the deployed sourceOutboxEvent unique constraint', () => {
    assert.equal(
      ACTIVITY_SOURCE_OUTBOX_EVENT_UNIQUE_CONSTRAINT,
      'activities_source_outbox_event_id_key_17bba872',
    );
  });
});
