import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import {
  getHousePulse,
  housePulseDtoSchema,
  maintenancePulseItemSchema,
  supplyPulseItemSchema,
  taskPulseItemSchema,
} from './pulse-api.js';
import {
  activeHousePulse,
  clearHousePulse,
  jsonResponse,
  TEST_HOME_A,
} from './test-fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetApiClientForTests();
});

describe('House Pulse API contracts', () => {
  it('GETs pulse with the exact homeId and credentials', async () => {
    const body = activeHousePulse();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getHousePulse(TEST_HOME_A);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/homes/${TEST_HOME_A}/pulse`);
    expect(init.credentials).toBe('include');
    expect(result).toEqual(body);
    expect(housePulseDtoSchema.safeParse(result).success).toBe(true);
  });

  it('consumes the exact backend DTO whitelist', () => {
    const dto = activeHousePulse();
    expect(Object.keys(dto).sort()).toEqual([
      'generatedAt',
      'homeLocalDate',
      'items',
    ]);
    expect(dto.items.map((item) => item.type)).toEqual([
      'TASKS',
      'SUPPLIES',
      'MAINTENANCE',
    ]);
    expect(taskPulseItemSchema.safeParse(dto.items[0]).success).toBe(true);
    expect(supplyPulseItemSchema.safeParse(dto.items[1]).success).toBe(true);
    expect(maintenancePulseItemSchema.safeParse(dto.items[2]).success).toBe(
      true,
    );
  });

  it('rejects extra fields and wrong item order', () => {
    expect(
      housePulseDtoSchema.safeParse({
        ...clearHousePulse(),
        score: 1,
      }).success,
    ).toBe(false);

    const valid = clearHousePulse();
    expect(
      housePulseDtoSchema.safeParse({
        ...valid,
        items: [valid.items[1], valid.items[0], valid.items[2]],
      }).success,
    ).toBe(false);
  });

  it('does not persist Pulse into storage', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, clearHousePulse()));
    vi.stubGlobal('fetch', fetchMock);

    await getHousePulse(TEST_HOME_A);

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
