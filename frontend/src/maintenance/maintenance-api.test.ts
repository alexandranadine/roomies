import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import {
  getMaintenanceEntry,
  listHomeMaintenance,
  maintenanceDetailSchema,
  maintenanceListItemSchema,
  maintenanceListPageSchema,
} from './maintenance-api.js';
import {
  detailFromListItem,
  FIXTURE_A,
  FIXTURE_H,
  jsonResponse,
  listPage,
  TEST_HOME_A,
} from './test-fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('maintenance API contracts', () => {
  it('lists maintenance without requiring details on list items', async () => {
    const page = listPage([FIXTURE_H, FIXTURE_A]);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, page));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listHomeMaintenance(TEST_HOME_A);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      `/api/v1/homes/${TEST_HOME_A}/maintenance`,
    );
    expect(init.credentials).toBe('include');
    expect(result.items).toEqual([FIXTURE_H, FIXTURE_A]);
    for (const item of result.items) {
      expect(item).not.toHaveProperty('details');
      expect(maintenanceListItemSchema.safeParse(item).success).toBe(true);
    }
    expect(maintenanceListPageSchema.safeParse(result).success).toBe(true);
  });

  it('omits status when listing All and sends OPEN/RESOLVED filters', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, listPage([]))),
      );
    vi.stubGlobal('fetch', fetchMock);

    await listHomeMaintenance(TEST_HOME_A);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).search).toBe('');

    await listHomeMaintenance(TEST_HOME_A, { status: 'OPEN' });
    expect(
      new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('status'),
    ).toBe('OPEN');

    await listHomeMaintenance(TEST_HOME_A, { status: 'RESOLVED' });
    expect(
      new URL(String(fetchMock.mock.calls[2]?.[0])).searchParams.get('status'),
    ).toBe('RESOLVED');
  });

  it('passes nextCursor through without decoding', async () => {
    const cursor = 'opaque-cursor-value-do-not-decode';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, listPage([])));
    vi.stubGlobal('fetch', fetchMock);

    await listHomeMaintenance(TEST_HOME_A, { cursor });

    expect(
      new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('cursor'),
    ).toBe(cursor);
  });

  it('parses detail with details and rejects list-shaped payloads missing details key', async () => {
    const detail = detailFromListItem(
      FIXTURE_A,
      'Under the cabinet, left side.',
    );
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, detail));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getMaintenanceEntry(TEST_HOME_A, FIXTURE_A.id);

    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      `/api/v1/homes/${TEST_HOME_A}/maintenance/${FIXTURE_A.id}`,
    );
    expect(result.details).toBe('Under the cabinet, left side.');
    expect(maintenanceDetailSchema.safeParse(result).success).toBe(true);
    expect(maintenanceDetailSchema.safeParse(FIXTURE_A).success).toBe(false);
  });

  it('does not require audience fields on list or detail DTOs', () => {
    expect(FIXTURE_A).not.toHaveProperty('audienceMembershipIds');
    expect(FIXTURE_A).not.toHaveProperty('audienceNames');
    expect(FIXTURE_A).not.toHaveProperty('hiddenCount');
    expect(FIXTURE_A).not.toHaveProperty('canView');

    const detail = detailFromListItem(FIXTURE_H, null);
    expect(detail).not.toHaveProperty('audienceMembershipIds');
    expect(maintenanceDetailSchema.safeParse(detail).success).toBe(true);
  });

  it('ignores inventing unknown server-only properties as schema fields', () => {
    const withExtra = {
      ...FIXTURE_H,
      canResolve: true,
      audienceNames: ['Sam'],
    };
    expect(maintenanceListItemSchema.safeParse(withExtra).success).toBe(false);
  });
});
