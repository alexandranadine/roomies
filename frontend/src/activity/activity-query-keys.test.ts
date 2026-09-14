import { describe, expect, it } from 'vitest';
import { activityKeys } from './activity-query-keys.js';
import { TEST_HOME_A, TEST_HOME_B } from './test-fixtures.js';

describe('activity query keys', () => {
  it('includes homeId in all and list keys', () => {
    expect(activityKeys.all(TEST_HOME_A)).toEqual([
      'home',
      TEST_HOME_A,
      'activity',
    ]);
    expect(activityKeys.list(TEST_HOME_A)).toEqual([
      'home',
      TEST_HOME_A,
      'activity',
      'list',
    ]);
    expect(activityKeys.all(TEST_HOME_A)[1]).toBe(TEST_HOME_A);
    expect(activityKeys.list(TEST_HOME_A)[1]).toBe(TEST_HOME_A);
  });

  it('does not share keys across Homes', () => {
    expect(activityKeys.all(TEST_HOME_A)).not.toEqual(
      activityKeys.all(TEST_HOME_B),
    );
    expect(activityKeys.list(TEST_HOME_A)).not.toEqual(
      activityKeys.list(TEST_HOME_B),
    );
  });
});
