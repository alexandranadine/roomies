import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, resetApiClientForTests } from '../platform/api/index.js';
import {
  listNotifications,
  markNotificationRead,
  notificationListItemSchema,
  notificationListPageSchema,
  readAllNotifications,
} from './notifications-api.js';
import {
  FIXTURE_TASK_TITLED,
  jsonResponse,
  listPage,
  notFoundBody,
  TEST_HOME_A,
  TEST_USER_ID,
  unauthenticatedBody,
  emptyResponse,
} from './test-fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('notifications API contracts', () => {
  it('fetches the global Notification list without homeId', async () => {
    const page = listPage([FIXTURE_TASK_TITLED]);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, page));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listNotifications();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v1/notifications');
    expect(parsed.search).toBe('');
    expect(parsed.searchParams.has('homeId')).toBe(false);
    expect(init.credentials).toBe('include');
    expect(result.items).toEqual([FIXTURE_TASK_TITLED]);
    expect(notificationListPageSchema.safeParse(result).success).toBe(true);
  });

  it('encodes cursor and limit correctly and never sends homeId', async () => {
    const cursor = 'opaque-cursor-value-do-not-decode';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, listPage([])));
    vi.stubGlobal('fetch', fetchMock);

    await listNotifications({ cursor, limit: 10 });

    const parsed = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect([...parsed.searchParams.keys()].sort()).toEqual(['cursor', 'limit']);
    expect(parsed.searchParams.get('cursor')).toBe(cursor);
    expect(parsed.searchParams.get('limit')).toBe('10');
    expect(parsed.searchParams.has('homeId')).toBe(false);
    expect(parsed.search).not.toContain(TEST_HOME_A);
    expect(parsed.search).not.toContain(TEST_USER_ID);
  });

  it('POSTs mark-one using the exact Notification ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await markNotificationRead(FIXTURE_TASK_TITLED.id);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(
      `/api/v1/notifications/${FIXTURE_TASK_TITLED.id}/read`,
    );
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('POSTs read-all to the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await readAllNotifications();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v1/notifications/read-all');
    expect(init.method).toBe('POST');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('surfaces 401 as ApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, unauthenticatedBody()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listNotifications()).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'UNAUTHENTICATED',
    } satisfies Partial<ApiError>);
  });

  it('surfaces concealed mark-one 404 as ApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, notFoundBody()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      markNotificationRead(FIXTURE_TASK_TITLED.id),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'NOT_FOUND',
    } satisfies Partial<ApiError>);
  });

  it('rejects leaked privacy fields on the wire DTO', () => {
    const leaked = {
      ...FIXTURE_TASK_TITLED,
      userId: TEST_USER_ID,
      audience: ['hidden'],
      membershipId: 'm1111111-1111-4111-8111-111111111111',
    };
    expect(notificationListItemSchema.safeParse(leaked).success).toBe(false);
  });
});
