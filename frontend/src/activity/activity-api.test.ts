import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, resetApiClientForTests } from '../platform/api/index.js';
import {
  activityListItemSchema,
  activityListPageSchema,
  listHomeActivity,
} from './activity-api.js';
import {
  FIXTURE_TASK_TITLED,
  jsonResponse,
  listPage,
  notFoundBody,
  TEST_HOME_A,
  TEST_MEMBERSHIP_ALEX,
  TEST_USER_ID,
  unauthenticatedBody,
} from './test-fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('activity API contracts', () => {
  it('fetches the first Activity page for the current Home', async () => {
    const page = listPage([FIXTURE_TASK_TITLED]);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, page));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listHomeActivity(TEST_HOME_A);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/api/v1/homes/${TEST_HOME_A}/activity`);
    expect(parsed.search).toBe('');
    expect(init.credentials).toBe('include');
    expect(result.items).toEqual([FIXTURE_TASK_TITLED]);
    expect(activityListPageSchema.safeParse(result).success).toBe(true);
  });

  it('sends cursor only for a later page and omits limit by default', async () => {
    const cursor = 'opaque-cursor-value-do-not-decode';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, listPage([])));
    vi.stubGlobal('fetch', fetchMock);

    await listHomeActivity(TEST_HOME_A, { cursor });

    const parsed = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect([...parsed.searchParams.keys()]).toEqual(['cursor']);
    expect(parsed.searchParams.get('cursor')).toBe(cursor);
    expect(parsed.searchParams.has('limit')).toBe(false);
    expect(parsed.searchParams.has('userId')).toBe(false);
    expect(parsed.searchParams.has('membershipId')).toBe(false);
    expect(parsed.searchParams.has('role')).toBe(false);
    expect(parsed.searchParams.has('visibilityClass')).toBe(false);
    expect(parsed.searchParams.has('visibility')).toBe(false);
  });

  it('exposes limit only when a caller supplies it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, listPage([])));
    vi.stubGlobal('fetch', fetchMock);

    await listHomeActivity(TEST_HOME_A, { limit: 10 });

    const parsed = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(parsed.searchParams.get('limit')).toBe('10');
  });

  it('does not send user, membership, role, or privacy query params', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, listPage([])));
    vi.stubGlobal('fetch', fetchMock);

    await listHomeActivity(TEST_HOME_A);

    const parsed = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect([...parsed.searchParams.keys()]).toEqual([]);
    expect(parsed.search).not.toContain(TEST_USER_ID);
    expect(parsed.search).not.toContain(TEST_MEMBERSHIP_ALEX);
  });

  it('surfaces 401 as ApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, unauthenticatedBody()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listHomeActivity(TEST_HOME_A)).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'UNAUTHENTICATED',
    } satisfies Partial<ApiError>);
  });

  it('surfaces 404 as ApiError using Home concealment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, notFoundBody()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listHomeActivity(TEST_HOME_A)).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'NOT_FOUND',
    } satisfies Partial<ApiError>);
  });

  it('rejects extra privacy fields on the wire DTO', () => {
    const leaked = {
      ...FIXTURE_TASK_TITLED,
      visibilityClass: 'SOURCE_AUTHORIZED',
      audience: ['hidden'],
      userId: TEST_USER_ID,
    };
    expect(activityListItemSchema.safeParse(leaked).success).toBe(false);
    expect(activityListPageSchema.safeParse(listPage([leaked])).success).toBe(
      false,
    );
  });

  it('accepts null historical names and source titles', () => {
    const unnamed = {
      ...FIXTURE_TASK_TITLED,
      actor: { membershipId: TEST_MEMBERSHIP_ALEX, name: null },
      sourceTitle: null,
    };
    expect(activityListItemSchema.safeParse(unnamed).success).toBe(true);
  });
});
