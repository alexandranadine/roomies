import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import {
  CURRENT_MEMBERSHIP_ID,
  OTHER_MEMBERSHIP_ID,
  stubRoommatesApis,
  TEST_HOME_A,
} from '../roommates/test-stub.js';
import { renderApp } from '../test/render.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Home roommate strip', () => {
  it('renders active members with You for the current member and no IDs', async () => {
    stubRoommatesApis();
    renderApp(`/homes/${TEST_HOME_A}`);

    const strip = await screen.findByRole('region', { name: 'Roommates' });
    expect(strip).toHaveTextContent('You');
    expect(strip).toHaveTextContent('Jamie');
    expect(strip.textContent).not.toContain(CURRENT_MEMBERSHIP_ID);
    expect(strip.textContent).not.toContain(OTHER_MEMBERSHIP_ID);
    expect(strip.textContent).not.toMatch(/DND|At work|Home Admin/);
  });

  it('truncates long names and stays in a horizontal row for many roommates', async () => {
    stubRoommatesApis({
      memberships: {
        currentMembershipId: CURRENT_MEMBERSHIP_ID,
        memberships: [
          {
            membershipId: CURRENT_MEMBERSHIP_ID,
            name: 'Alexandra With A Very Long Display Name',
          },
          { membershipId: OTHER_MEMBERSHIP_ID, name: 'Jamie' },
          {
            membershipId: 'm5555555-5555-4555-8555-555555555555',
            name: 'Morgan',
          },
          {
            membershipId: 'm6666666-6666-4666-8666-666666666666',
            name: 'Riley',
          },
          {
            membershipId: 'm7777777-7777-4777-8777-777777777777',
            name: 'Sam',
          },
          {
            membershipId: 'm8888888-8888-4888-8888-888888888888',
            name: 'Quinn',
          },
        ],
      },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    const strip = await screen.findByRole('region', { name: 'Roommates' });
    expect(strip).toHaveClass('min-w-0');
    expect(strip.querySelector('ul')).toHaveClass('overflow-x-auto');
    expect(strip).toHaveTextContent('You');
    expect(strip).toHaveTextContent('Jamie');
    expect(strip.textContent).not.toContain('m5555555-5555-4555-8555-555555555555');
    expect(strip.querySelectorAll('li').length).toBe(6);
  });
});
