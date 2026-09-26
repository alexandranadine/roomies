import { describe, expect, it } from 'vitest';
import { createAppQueryClient } from '../platform/query/query-client.js';
import { taskKeys } from '../tasks/tasks-query-keys.js';
import {
  markAllNotificationsReadInCache,
  markNotificationReadInCache,
  READ_IN_CACHE_PLACEHOLDER,
} from './notifications-list-cache.js';
import { notificationKeys } from './notifications-query-keys.js';
import {
  FIXTURE_READ_TASK,
  FIXTURE_ROLE_CHANGED,
  FIXTURE_TASK_TITLED,
  listPage,
} from './test-fixtures.js';

const listKey = notificationKeys.list({});

describe('notifications-list-cache', () => {
  it('marks one notification read in cached pages without changing others', () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(listKey, {
      pages: [
        listPage([FIXTURE_TASK_TITLED, FIXTURE_ROLE_CHANGED]),
        listPage([FIXTURE_READ_TASK], { hasMore: false, nextCursor: null }),
      ],
      pageParams: [undefined, 'cursor-2'],
    });

    markNotificationReadInCache(queryClient, FIXTURE_TASK_TITLED.id);

    const cached = queryClient.getQueryData<{
      pages: { items: { id: string; readAt: string | null }[] }[];
      pageParams: unknown[];
    }>(listKey);
    expect(cached?.pages[0]?.items[0]?.readAt).toBe(READ_IN_CACHE_PLACEHOLDER);
    expect(cached?.pages[0]?.items[1]?.readAt).toBeNull();
    expect(cached?.pages[1]?.items[0]?.readAt).toBe(FIXTURE_READ_TASK.readAt);
    expect(cached?.pageParams).toEqual([undefined, 'cursor-2']);
  });

  it('marks all cached notifications read while preserving pagination', () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(listKey, {
      pages: [
        listPage([FIXTURE_TASK_TITLED], {
          hasMore: true,
          nextCursor: 'cursor-2',
        }),
        listPage([FIXTURE_ROLE_CHANGED], { hasMore: false, nextCursor: null }),
      ],
      pageParams: [undefined, 'cursor-2'],
    });

    markAllNotificationsReadInCache(queryClient);

    const cached = queryClient.getQueryData<{
      pages: {
        items: { readAt: string | null }[];
        hasMore: boolean;
        nextCursor: string | null;
      }[];
      pageParams: unknown[];
    }>(listKey);
    expect(cached?.pages[0]?.items.every((item) => item.readAt !== null)).toBe(
      true,
    );
    expect(cached?.pages[1]?.items.every((item) => item.readAt !== null)).toBe(
      true,
    );
    expect(cached?.pages[0]?.hasMore).toBe(true);
    expect(cached?.pages[0]?.nextCursor).toBe('cursor-2');
    expect(cached?.pageParams).toEqual([undefined, 'cursor-2']);
  });

  it('does not touch unrelated query caches', () => {
    const queryClient = createAppQueryClient();
    const homeId = FIXTURE_TASK_TITLED.destination.homeId;
    queryClient.setQueryData(listKey, {
      pages: [listPage([FIXTURE_TASK_TITLED])],
      pageParams: [undefined],
    });
    queryClient.setQueryData(taskKeys.list(homeId), []);

    markNotificationReadInCache(queryClient, FIXTURE_TASK_TITLED.id);

    expect(queryClient.getQueryData(taskKeys.list(homeId))).toEqual([]);
  });
});
