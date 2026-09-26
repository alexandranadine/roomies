import { describe, expect, it } from 'vitest';
import { homeRoleLabel, roommateRosterRoleLabel } from './home-role-label.js';

describe('homeRoleLabel', () => {
  it('uses Home Admin and Roommate, never Owner or Membership', () => {
    expect(homeRoleLabel('ADMIN')).toBe('Home Admin');
    expect(homeRoleLabel('ROOMMATE')).toBe('Roommate');
    expect(
      `${homeRoleLabel('ADMIN')} ${homeRoleLabel('ROOMMATE')}`,
    ).not.toMatch(/owner|membership/i);
  });
});

describe('roommateRosterRoleLabel', () => {
  it('uses Home Admin and Household member from roster role', () => {
    expect(roommateRosterRoleLabel('ADMIN')).toBe('Home Admin');
    expect(roommateRosterRoleLabel('ROOMMATE')).toBe('Household member');
  });
});
