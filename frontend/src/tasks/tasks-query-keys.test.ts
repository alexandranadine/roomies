import { describe, expect, it } from 'vitest';
import { taskKeys } from './tasks-query-keys.js';
import { TEST_HOME_A, TEST_HOME_B } from './test-fixtures.js';

describe('task query keys', () => {
  it('includes homeId in all, list, and definitions keys', () => {
    expect(taskKeys.all(TEST_HOME_A)).toEqual(['home', TEST_HOME_A, 'tasks']);
    expect(taskKeys.list(TEST_HOME_A)).toEqual([
      'home',
      TEST_HOME_A,
      'tasks',
      'list',
    ]);
    expect(taskKeys.definitions(TEST_HOME_A)).toEqual([
      'home',
      TEST_HOME_A,
      'tasks',
      'definitions',
    ]);
    expect(taskKeys.all(TEST_HOME_A)[1]).toBe(TEST_HOME_A);
    expect(taskKeys.list(TEST_HOME_A)[1]).toBe(TEST_HOME_A);
    expect(taskKeys.definitions(TEST_HOME_A)[1]).toBe(TEST_HOME_A);
  });

  it('does not share keys across Homes', () => {
    expect(taskKeys.all(TEST_HOME_A)).not.toEqual(taskKeys.all(TEST_HOME_B));
    expect(taskKeys.list(TEST_HOME_A)).not.toEqual(taskKeys.list(TEST_HOME_B));
    expect(taskKeys.definitions(TEST_HOME_A)).not.toEqual(
      taskKeys.definitions(TEST_HOME_B),
    );
  });
});
