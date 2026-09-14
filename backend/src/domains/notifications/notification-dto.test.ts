import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NotificationListItem } from './notification-list-item.js';
import {
  notificationListPageDtoSchema,
  toNotificationListItemDto,
  toNotificationListPageDto,
} from './notification-dto.js';

const OCCURRED = new Date('2026-09-13T18:00:00.000Z');
const READ = new Date('2026-09-13T19:00:00.000Z');

function item(
  overrides: Partial<NotificationListItem> = {},
): NotificationListItem {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    kind: 'ASSIGNED_TASK_COMPLETED',
    occurredAt: OCCURRED,
    readAt: null,
    home: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Home A' },
    actor: { name: 'Alex' },
    source: { type: 'TASK', title: 'Take out trash' },
    destination: {
      type: 'TASK',
      homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskInstanceId: '018f1e2c-7e3a-7000-8000-1234567890ab',
    },
    ...overrides,
  };
}

void describe('Notification list DTO', () => {
  void it('serializes the frozen safe presentation contract', () => {
    const dto = toNotificationListItemDto(item({ readAt: READ }));
    assert.deepEqual(Object.keys(dto), [
      'id',
      'kind',
      'occurredAt',
      'readAt',
      'home',
      'actor',
      'source',
      'destination',
    ]);
    assert.equal(dto.occurredAt, OCCURRED.toISOString());
    assert.equal(dto.readAt, READ.toISOString());
    assert.equal('membershipId' in (dto.actor ?? {}), false);
    assert.equal('userId' in dto, false);
    assert.equal('recipientMembershipId' in dto, false);
  });

  void it('keeps PRIVATE Maintenance generic and omits protected fields', () => {
    const dto = toNotificationListItemDto(
      item({
        kind: 'PRIVATE_MAINTENANCE_CREATED',
        source: null,
        destination: {
          type: 'HOME',
          homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      }),
    );
    assert.equal(dto.source, null);
    assert.deepEqual(dto.destination, {
      type: 'HOME',
      homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    assert.equal('sourceEntityId' in dto, false);
    assert.equal('title' in (dto.source ?? {}), false);
    assert.equal('details' in dto, false);
    assert.equal('audience' in dto, false);
  });

  void it('serializes an empty page', () => {
    const page = toNotificationListPageDto({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    assert.deepEqual(notificationListPageDtoSchema.parse(page), {
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  });
});
