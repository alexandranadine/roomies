import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FIND_ELIGIBLE_NOTIFICATION_SQL,
  LIST_ELIGIBLE_NOTIFICATION_PAGE_SQL,
  MARK_ELIGIBLE_NOTIFICATION_READ_SQL,
  NOTIFICATION_PRIVATE_MAINTENANCE_VISIBLE_SQL,
  NOTIFICATION_RECIPIENT_HOME_SQL,
  NOTIFICATION_RECIPIENT_MEMBERSHIP_SQL,
  READ_ALL_ELIGIBLE_UNREAD_SQL,
} from './repository.js';

function assertRecipientMembership(sql: string): void {
  assert.match(sql, /memberships\.id = n\.recipient_membership_id/);
  assert.match(sql, /memberships\.user_id = \$1::uuid/);
  assert.match(sql, /memberships\.ended_at IS NULL/);
  assert.match(sql, /memberships\.home_id = n\.home_id/);
}

function assertRecipientHome(sql: string): void {
  assert.match(sql, /homes\.id = memberships\.home_id/);
  assert.match(sql, /homes\.archived_at IS NULL/);
}

function assertRecipientScope(sql: string): void {
  assertRecipientMembership(sql);
  assertRecipientHome(sql);
}

function assertPrivateVisibility(sql: string): void {
  assert.match(sql, /PRIVATE_MAINTENANCE_CREATED/);
  assert.match(sql, /PRIVATE_MAINTENANCE_RESOLVED/);
  assert.match(sql, /e\.visibility = 'PRIVATE'/);
  assert.match(sql, /FROM maintenance_audiences a/);
  assert.match(sql, /a\.membership_id = n\.recipient_membership_id/);
}

function assertNoBypass(sql: string): void {
  assert.doesNotMatch(sql, /\brole\b/);
  assert.doesNotMatch(sql, /ADMIN/);
  assert.doesNotMatch(sql, /isHomeAdmin/);
}

void describe('canonical Notification visibility SQL', () => {
  void it('owns one recipient-scope and PRIVATE Maintenance fragment', () => {
    assertRecipientMembership(NOTIFICATION_RECIPIENT_MEMBERSHIP_SQL);
    assertRecipientHome(NOTIFICATION_RECIPIENT_HOME_SQL);
    assertPrivateVisibility(NOTIFICATION_PRIVATE_MAINTENANCE_VISIBLE_SQL);
    assertNoBypass(NOTIFICATION_RECIPIENT_MEMBERSHIP_SQL);
    assertNoBypass(NOTIFICATION_PRIVATE_MAINTENANCE_VISIBLE_SQL);
  });

  void it('applies visibility before cursor, order, and limit', () => {
    const sql = LIST_ELIGIBLE_NOTIFICATION_PAGE_SQL;
    assertRecipientScope(sql);
    assertPrivateVisibility(sql);
    assertNoBypass(sql);
    const visibilityAt = sql.indexOf("e.visibility = 'PRIVATE'");
    const cursorAt = sql.indexOf('n.occurred_at < $2::timestamptz');
    const orderAt = sql.indexOf('ORDER BY');
    const limitAt = sql.indexOf('LIMIT $4');
    assert.ok(visibilityAt >= 0 && cursorAt > visibilityAt);
    assert.ok(orderAt > cursorAt);
    assert.ok(limitAt > orderAt);
    assert.match(sql, /n\.occurred_at DESC/);
    assert.match(sql, /n\.id DESC/);
    assert.doesNotMatch(sql, /OFFSET/);
    assert.doesNotMatch(sql, /COUNT\(\*\)/);
    assert.doesNotMatch(sql, /findAllNotificationsForUser/);
  });

  void it('keeps mark-one and read-all visibility-shaped', () => {
    assertRecipientScope(FIND_ELIGIBLE_NOTIFICATION_SQL);
    assertPrivateVisibility(FIND_ELIGIBLE_NOTIFICATION_SQL);
    assertRecipientScope(MARK_ELIGIBLE_NOTIFICATION_READ_SQL);
    assertPrivateVisibility(MARK_ELIGIBLE_NOTIFICATION_READ_SQL);
    assert.match(
      MARK_ELIGIBLE_NOTIFICATION_READ_SQL,
      /transaction_timestamp\(\)/,
    );
    assert.match(
      MARK_ELIGIBLE_NOTIFICATION_READ_SQL,
      /eligible\.read_at IS NULL/,
    );
    assertRecipientScope(READ_ALL_ELIGIBLE_UNREAD_SQL);
    assertPrivateVisibility(READ_ALL_ELIGIBLE_UNREAD_SQL);
    assert.match(
      READ_ALL_ELIGIBLE_UNREAD_SQL,
      /n\.created_at <= \$2::timestamptz/,
    );
    assert.doesNotMatch(READ_ALL_ELIGIBLE_UNREAD_SQL, /occurred_at/);
    assert.doesNotMatch(READ_ALL_ELIGIBLE_UNREAD_SQL, /RETURNING/);
    assertNoBypass(MARK_ELIGIBLE_NOTIFICATION_READ_SQL);
    assertNoBypass(READ_ALL_ELIGIBLE_UNREAD_SQL);
  });
});
