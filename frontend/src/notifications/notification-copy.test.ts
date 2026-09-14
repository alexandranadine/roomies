import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_KINDS,
  presentNotification,
} from './notification-copy.js';
import { notificationItem } from './test-fixtures.js';

describe('presentNotification', () => {
  it('renders human copy for all five known kinds without enum names', () => {
    const presentations = [
      presentNotification(
        notificationItem({
          kind: NOTIFICATION_KINDS.MEMBERSHIP_ROLE_CHANGED,
          actor: null,
          source: null,
        }),
      ),
      presentNotification(
        notificationItem({
          kind: NOTIFICATION_KINDS.ASSIGNED_TASK_COMPLETED,
          actor: { name: 'Alex' },
        }),
      ),
      presentNotification(
        notificationItem({
          kind: NOTIFICATION_KINDS.CREATED_SUPPLY_OBTAINED,
          actor: { name: 'Alex' },
          source: { type: 'SUPPLY', title: 'Paper towels' },
        }),
      ),
      presentNotification(
        notificationItem({
          kind: NOTIFICATION_KINDS.PRIVATE_MAINTENANCE_CREATED,
          actor: null,
          source: null,
        }),
      ),
      presentNotification(
        notificationItem({
          kind: NOTIFICATION_KINDS.PRIVATE_MAINTENANCE_RESOLVED,
          actor: null,
          source: null,
        }),
      ),
    ];

    expect(presentations.map((p) => p.message)).toEqual([
      'Your roommate role changed',
      'Alex completed a task assigned to you',
      'Alex picked up a supply you added',
      'New private maintenance update',
      'Private maintenance was resolved',
    ]);

    for (const presentation of presentations) {
      expect(presentation.message).not.toMatch(
        /MEMBERSHIP_|ASSIGNED_|CREATED_|PRIVATE_/,
      );
      expect(presentation.message).not.toContain('MEMBERSHIP_ROLE_CHANGED');
      expect(presentation.message).not.toContain('ASSIGNED_TASK_COMPLETED');
      expect(presentation.message).not.toContain('CREATED_SUPPLY_OBTAINED');
      expect(presentation.message).not.toContain('PRIVATE_MAINTENANCE_CREATED');
      expect(presentation.message).not.toContain(
        'PRIVATE_MAINTENANCE_RESOLVED',
      );
    }
  });

  it('falls back when actor is null for task and supply', () => {
    expect(
      presentNotification(
        notificationItem({
          kind: NOTIFICATION_KINDS.ASSIGNED_TASK_COMPLETED,
          actor: null,
          source: null,
        }),
      ).message,
    ).toBe('A task assigned to you was completed');

    expect(
      presentNotification(
        notificationItem({
          kind: NOTIFICATION_KINDS.CREATED_SUPPLY_OBTAINED,
          actor: null,
          source: null,
        }),
      ).message,
    ).toBe('A supply you added was picked up');
  });

  it('exposes safe Task/Supply titles and omits them when source is null', () => {
    expect(
      presentNotification(
        notificationItem({
          source: { type: 'TASK', title: 'Take out trash' },
        }),
      ).sourceTitle,
    ).toBe('Take out trash');

    expect(
      presentNotification(
        notificationItem({
          kind: NOTIFICATION_KINDS.CREATED_SUPPLY_OBTAINED,
          source: { type: 'SUPPLY', title: 'Paper towels' },
        }),
      ).sourceTitle,
    ).toBe('Paper towels');

    expect(
      presentNotification(notificationItem({ source: null })).sourceTitle,
    ).toBeNull();
  });

  it('keeps PRIVATE Maintenance generic with no source title', () => {
    const created = presentNotification(
      notificationItem({
        kind: NOTIFICATION_KINDS.PRIVATE_MAINTENANCE_CREATED,
        source: null,
      }),
    );
    const resolved = presentNotification(
      notificationItem({
        kind: NOTIFICATION_KINDS.PRIVATE_MAINTENANCE_RESOLVED,
        source: null,
      }),
    );

    expect(created.sourceTitle).toBeNull();
    expect(resolved.sourceTitle).toBeNull();
    expect(created.message).not.toMatch(/title|details|audience|Quiet leak/i);
    expect(resolved.message).not.toMatch(/title|details|audience|Quiet leak/i);
  });

  it('uses a generic presentation for unknown future kinds', () => {
    const unknown = presentNotification(
      notificationItem({ kind: 'FUTURE_KIND_V9' }),
    );
    expect(unknown.message).toBe('You have a new notification');
    expect(unknown.message).not.toContain('FUTURE_KIND_V9');
  });
});
