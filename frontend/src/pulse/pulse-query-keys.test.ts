import { describe, expect, it } from 'vitest';
import { pulseKeys } from './pulse-query-keys.js';
import { TEST_HOME_A, TEST_HOME_B } from './test-fixtures.js';

describe('pulse query keys', () => {
  it('includes homeId in the Pulse key', () => {
    expect(pulseKeys.all(TEST_HOME_A)).toEqual(['home', TEST_HOME_A, 'pulse']);
    expect(pulseKeys.all(TEST_HOME_A)[1]).toBe(TEST_HOME_A);
  });

  it('does not share keys across Homes', () => {
    expect(pulseKeys.all(TEST_HOME_A)).not.toEqual(pulseKeys.all(TEST_HOME_B));
  });
});
