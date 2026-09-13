import { describe, expect, it } from 'vitest';
import { maintenanceKeys } from './maintenance-query-keys.js';
import { TEST_HOME_A, TEST_HOME_B } from './test-fixtures.js';

describe('maintenance query keys', () => {
  it('includes homeId in all, list, and detail keys', () => {
    expect(maintenanceKeys.all(TEST_HOME_A)).toEqual([
      'home',
      TEST_HOME_A,
      'maintenance',
    ]);
    expect(maintenanceKeys.list(TEST_HOME_A, { status: 'OPEN' })).toEqual([
      'home',
      TEST_HOME_A,
      'maintenance',
      'list',
      { status: 'OPEN' },
    ]);
    expect(maintenanceKeys.detail(TEST_HOME_A, 'entry-1')).toEqual([
      'home',
      TEST_HOME_A,
      'maintenance',
      'detail',
      'entry-1',
    ]);

    expect(maintenanceKeys.all(TEST_HOME_A)[1]).toBe(TEST_HOME_A);
    expect(maintenanceKeys.list(TEST_HOME_A)[1]).toBe(TEST_HOME_A);
    expect(maintenanceKeys.detail(TEST_HOME_A, 'entry-1')[1]).toBe(TEST_HOME_A);
  });

  it('does not share keys across Homes', () => {
    expect(maintenanceKeys.all(TEST_HOME_A)).not.toEqual(
      maintenanceKeys.all(TEST_HOME_B),
    );
    expect(maintenanceKeys.list(TEST_HOME_A)).not.toEqual(
      maintenanceKeys.list(TEST_HOME_B),
    );
    expect(maintenanceKeys.detail(TEST_HOME_A, 'same-id')).not.toEqual(
      maintenanceKeys.detail(TEST_HOME_B, 'same-id'),
    );
  });
});
