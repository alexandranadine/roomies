import { describe, expect, it } from 'vitest';
import {
  createMaintenanceFormSchema,
  toCreateMaintenanceRequest,
  type CreateMaintenanceFormValues,
} from './create-maintenance-form-schema.js';
import { TEST_MEMBERSHIP_A, TEST_MEMBERSHIP_B } from './test-fixtures.js';

describe('toCreateMaintenanceRequest', () => {
  const base: CreateMaintenanceFormValues = {
    title: '  Fix sink  ',
    details: '  drip  ',
    visibility: 'HOUSEHOLD',
    audienceMembershipIds: [TEST_MEMBERSHIP_B, TEST_MEMBERSHIP_A],
  };

  it('maps HOUSEHOLD without audienceMembershipIds even if form held recipients', () => {
    const body = toCreateMaintenanceRequest(base);
    expect(body).toEqual({
      visibility: 'HOUSEHOLD',
      title: 'Fix sink',
      details: 'drip',
    });
    expect(body).not.toHaveProperty('audienceMembershipIds');
  });

  it('maps PRIVATE with unique sorted audienceMembershipIds including empty', () => {
    expect(
      toCreateMaintenanceRequest({
        ...base,
        visibility: 'PRIVATE',
        audienceMembershipIds: [],
        details: '   ',
      }),
    ).toEqual({
      visibility: 'PRIVATE',
      title: 'Fix sink',
      audienceMembershipIds: [],
    });

    expect(
      toCreateMaintenanceRequest({
        ...base,
        visibility: 'PRIVATE',
        audienceMembershipIds: [
          TEST_MEMBERSHIP_B,
          TEST_MEMBERSHIP_A,
          TEST_MEMBERSHIP_B,
        ],
      }),
    ).toEqual({
      visibility: 'PRIVATE',
      title: 'Fix sink',
      details: 'drip',
      audienceMembershipIds: [TEST_MEMBERSHIP_A, TEST_MEMBERSHIP_B].sort(),
    });
  });

  it('rejects details longer than 4000 in the form schema', () => {
    expect(
      createMaintenanceFormSchema.safeParse({
        ...base,
        details: 'x'.repeat(4001),
      }).success,
    ).toBe(false);
    expect(
      createMaintenanceFormSchema.safeParse({
        ...base,
        details: 'x'.repeat(4000),
      }).success,
    ).toBe(true);
  });
});
