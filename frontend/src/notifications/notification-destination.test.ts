import { describe, expect, it } from 'vitest';
import { notificationDestinationPath } from './notification-destination.js';
import {
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_SUPPLY_ID,
  TEST_TASK_ID,
} from './test-fixtures.js';

describe('notificationDestinationPath', () => {
  it('uses destination Home for Task, not an active-Home rewrite', () => {
    expect(
      notificationDestinationPath({
        type: 'TASK',
        homeId: TEST_HOME_B,
        taskInstanceId: TEST_TASK_ID,
      }),
    ).toBe(`/homes/${TEST_HOME_B}`);
  });

  it('uses destination Home for Supply', () => {
    expect(
      notificationDestinationPath({
        type: 'SUPPLY',
        homeId: TEST_HOME_B,
        supplyEntryId: TEST_SUPPLY_ID,
      }),
    ).toBe(`/homes/${TEST_HOME_B}`);
  });

  it('uses destination Home for Roommates', () => {
    expect(
      notificationDestinationPath({
        type: 'ROOMMATES',
        homeId: TEST_HOME_A,
      }),
    ).toBe(`/homes/${TEST_HOME_A}`);
  });

  it('uses destination Home for HOME and never builds Maintenance detail', () => {
    const path = notificationDestinationPath({
      type: 'HOME',
      homeId: TEST_HOME_B,
    });
    expect(path).toBe(`/homes/${TEST_HOME_B}`);
    expect(path).not.toContain('/maintenance');
  });
});
