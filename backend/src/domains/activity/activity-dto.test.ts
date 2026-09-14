import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActivityListItem } from './activity-list-item.js';
import {
  activityListItemDtoSchema,
  activityListPageDtoSchema,
  toActivityListItemDto,
  toActivityListPageDto,
} from './activity-dto.js';

const OCCURRED = new Date('2026-09-13T18:00:00.000Z');

function item(overrides: Partial<ActivityListItem> = {}): ActivityListItem {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    eventType: 'task.completed.v1',
    sourceEntityType: 'TASK',
    sourceEntityId: '018f1e2c-7e3a-7000-8000-1234567890ac',
    occurredAt: OCCURRED,
    actor: {
      membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Alex',
    },
    sourceTitle: 'Take out trash',
    subject: null,
    ...overrides,
  };
}

void describe('Activity list DTO', () => {
  void it('serializes the thin structured whitelist', () => {
    const dto = toActivityListItemDto(item());
    assert.deepEqual(Object.keys(dto), [
      'id',
      'eventType',
      'sourceEntityType',
      'sourceEntityId',
      'occurredAt',
      'actor',
      'sourceTitle',
      'subject',
    ]);
    assert.equal(dto.occurredAt, '2026-09-13T18:00:00.000Z');
    assert.equal('visibilityClass' in dto, false);
    assert.equal('userId' in dto, false);
    assert.equal('recipients' in dto, false);
    assert.equal('details' in dto, false);
    assert.equal('audience' in dto, false);
    assert.equal('audienceMembershipIds' in dto, false);
    activityListItemDtoSchema.parse(dto);
  });

  void it('preserves a valid empty page', () => {
    const page = toActivityListPageDto({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    assert.deepEqual(page, {
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    activityListPageDtoSchema.parse(page);
  });

  void it('keeps a null name for missing historical identity', () => {
    const dto = toActivityListItemDto(
      item({
        actor: {
          membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          name: null,
        },
      }),
    );
    assert.equal(dto.actor?.name, null);
  });
});
