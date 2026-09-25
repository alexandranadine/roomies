import { describe, expect, it } from 'vitest';
import {
  homeOverviewHref,
  parseHomeIdFromPath,
  resolveWordmarkHomeHref,
} from './wordmark-home-href.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('parseHomeIdFromPath', () => {
  it('reads a valid Home id from Home-scoped routes', () => {
    expect(parseHomeIdFromPath(`/homes/${HOME_A}`)).toBe(HOME_A);
    expect(parseHomeIdFromPath(`/homes/${HOME_A}/tasks`)).toBe(HOME_A);
  });

  it('ignores invalid Home ids', () => {
    expect(parseHomeIdFromPath('/homes/not-a-uuid')).toBeUndefined();
    expect(parseHomeIdFromPath('/account')).toBeUndefined();
  });
});

describe('resolveWordmarkHomeHref', () => {
  it('keeps the current Home on Home-scoped routes', () => {
    expect(
      resolveWordmarkHomeHref({
        pathname: `/homes/${HOME_A}/activity`,
        currentUserHomes: [{ id: HOME_B }],
        cachedHomeContexts: [{ homeId: HOME_B, dataUpdatedAt: 100 }],
      }),
    ).toBe(homeOverviewHref(HOME_A));
  });

  it('uses the sole active Home on global routes', () => {
    expect(
      resolveWordmarkHomeHref({
        pathname: '/account',
        currentUserHomes: [{ id: HOME_A }],
        cachedHomeContexts: [],
      }),
    ).toBe(homeOverviewHref(HOME_A));
  });

  it('uses the most recent cached Home context when multiple Homes exist', () => {
    expect(
      resolveWordmarkHomeHref({
        pathname: '/notifications',
        currentUserHomes: [{ id: HOME_A }, { id: HOME_B }],
        cachedHomeContexts: [
          { homeId: HOME_A, dataUpdatedAt: 100 },
          { homeId: HOME_B, dataUpdatedAt: 200 },
        ],
      }),
    ).toBe(homeOverviewHref(HOME_B));
  });

  it('falls back to discovery when no Home can be resolved safely', () => {
    expect(
      resolveWordmarkHomeHref({
        pathname: '/account',
        currentUserHomes: [{ id: HOME_A }, { id: HOME_B }],
        cachedHomeContexts: [],
      }),
    ).toBe('/');
  });

  it('ignores cached Homes that are no longer authorized', () => {
    expect(
      resolveWordmarkHomeHref({
        pathname: '/notifications',
        currentUserHomes: [{ id: HOME_A }],
        cachedHomeContexts: [{ homeId: HOME_B, dataUpdatedAt: 200 }],
      }),
    ).toBe(homeOverviewHref(HOME_A));
  });
});
