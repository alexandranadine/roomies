import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import { pulseKeys } from './pulse-query-keys.js';
import {
  activeHousePulse,
  clearHousePulse,
  clearMaintenanceItem,
  clearSuppliesItem,
  clearTasksItem,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
} from './test-fixtures.js';
import { stubPulseApis } from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function pulseRegion() {
  return screen.getByTestId('house-pulse');
}

describe('House Pulse on Home overview', () => {
  it('renders House Pulse with fixed Tasks → Supplies → Maintenance order', async () => {
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: activeHousePulse() },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'House Pulse', level: 2 }),
    ).toBeInTheDocument();

    const region = pulseRegion();
    expect(region).toHaveAttribute('aria-labelledby', 'house-pulse-heading');

    const headings = within(region).getAllByRole('heading', { level: 3 });
    expect(headings.map((node) => node.textContent)).toEqual([
      'Tasks',
      'Supplies',
      'Maintenance',
    ]);
  });

  it('keeps CLEAR sections rendered and does not reorder ACTIVE above CLEAR', async () => {
    stubPulseApis({
      pulseByHome: {
        [TEST_HOME_A]: clearHousePulse({
          items: [
            clearTasksItem(),
            clearSuppliesItem({
              state: 'ACTIVE',
              openCount: 2,
              unclaimedOpenCount: 1,
              claimedByMeCount: 0,
            }),
            clearMaintenanceItem(),
          ],
        }),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    const region = await screen.findByTestId('house-pulse');
    const headings = within(region).getAllByRole('heading', { level: 3 });
    expect(headings.map((node) => node.textContent)).toEqual([
      'Tasks',
      'Supplies',
      'Maintenance',
    ]);
    expect(
      within(region).getByText('Nothing needs attention.'),
    ).toBeInTheDocument();
    expect(
      within(region).queryByText('No open supplies.'),
    ).not.toBeInTheDocument();
    expect(within(region).getByText(/Open:/)).toBeInTheDocument();
    expect(
      within(region).getByText('No open maintenance visible to you.'),
    ).toBeInTheDocument();
  });

  it('displays Task, Supply, and Maintenance counters from the backend DTO', async () => {
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: activeHousePulse() },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    const region = await screen.findByTestId('house-pulse');
    expect(region).toHaveTextContent('Assigned to you: 2');
    expect(region).toHaveTextContent('Unassigned: 1');
    expect(region).toHaveTextContent('Due today: 1');
    expect(region).toHaveTextContent('Overdue: 3');
    expect(region).toHaveTextContent('Open: 4');
    expect(region).toHaveTextContent('Unclaimed: 2');
    expect(region).toHaveTextContent('Claimed by you: 1');
    expect(region).toHaveTextContent('2 open items visible to you');
  });

  it('uses singular Maintenance ACTIVE copy', async () => {
    stubPulseApis({
      pulseByHome: {
        [TEST_HOME_A]: clearHousePulse({
          items: [
            clearTasksItem(),
            clearSuppliesItem(),
            clearMaintenanceItem({ state: 'ACTIVE', openVisibleCount: 1 }),
          ],
        }),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByText('1 open item visible to you'),
    ).toBeInTheDocument();
  });

  it('does not prominently show generatedAt, scores, charts, or Maintenance details', async () => {
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: activeHousePulse() },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    const region = await screen.findByTestId('house-pulse');
    const text = region.textContent ?? '';
    expect(text).not.toContain('2026-09-14T04:00:00.000Z');
    expect(text).not.toMatch(/score|rank|progress|chart|percent/i);
    expect(text).not.toMatch(/private|hidden|household|audience/i);
    expect(text).not.toMatch(/Quiet leak|furnace|title/i);
    expect(within(region).queryByRole('img')).not.toBeInTheDocument();
  });

  it('exposes CLEAR/ACTIVE as text badges, not color-only', async () => {
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: activeHousePulse() },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    const region = await screen.findByTestId('house-pulse');
    expect(within(region).getAllByText('Active').length).toBe(3);
    expect(
      within(region).getAllByText('Active')[0]?.closest('[data-pulse-state]'),
    ).toHaveAttribute('data-pulse-state', 'ACTIVE');
  });

  it('links Tasks to the existing Home Tasks destination', async () => {
    const user = userEvent.setup();
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: clearHousePulse() },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);

    const region = await screen.findByTestId('house-pulse');
    const links = within(region).getAllByRole('link', {
      name: 'Open Tasks',
    });
    expect(links).toHaveLength(1);
    await user.click(links[0]!);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/homes/${TEST_HOME_A}/tasks`,
      );
    });
  });

  it('links Maintenance to the existing Home Maintenance destination', async () => {
    const user = userEvent.setup();
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: clearHousePulse() },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);

    const region = await screen.findByTestId('house-pulse');
    const links = within(region).getAllByRole('link', {
      name: 'Open Maintenance',
    });
    expect(links).toHaveLength(1);
    await user.click(links[0]!);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/homes/${TEST_HOME_A}/maintenance`,
      );
    });
  });

  it('shows a loading skeleton without previous Home counts', async () => {
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: activeHousePulse() },
      pulseDelayMs: 80,
      delayedHomeId: TEST_HOME_A,
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('house-pulse-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('house-pulse')).not.toBeInTheDocument();
    expect(screen.queryByText('Assigned to you: 2')).not.toBeInTheDocument();

    expect(await screen.findByTestId('house-pulse')).toBeInTheDocument();
  });

  it('shows a recoverable Pulse error without breaking the rest of the overview', async () => {
    const user = userEvent.setup();
    let failOnce = true;
    stubPulseApis({
      pulseByHome: {
        [TEST_HOME_A]: () => {
          if (failOnce) {
            failOnce = false;
            return {
              status: 500,
              body: { error: { code: 'INTERNAL', message: 'boom' } },
            };
          }
          return activeHousePulse();
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn’t load House Pulse/,
    );
    expect(
      screen.getByRole('link', { name: 'Open Maintenance' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('house-pulse')).toBeInTheDocument();
  });

  it('shows Home unavailable for concealed Pulse 404 and clears stale Pulse', async () => {
    stubPulseApis({
      pulseByHome: {
        [TEST_HOME_A]: { status: 404, body: notFoundBody() },
      },
    });
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', {
        name: 'This Home isn’t available',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('house-pulse')).not.toBeInTheDocument();
    expect(screen.queryByText('Assigned to you')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/forbidden|permission/i);

    clearPrivateHomeQueryState(queryClient);
    expect(
      queryClient.getQueryData(pulseKeys.all(TEST_HOME_A)),
    ).toBeUndefined();
  });

  it('does not flash Home A Pulse counts when switching to Home B', async () => {
    stubPulseApis({
      pulseByHome: {
        [TEST_HOME_A]: activeHousePulse(),
        [TEST_HOME_B]: clearHousePulse({
          items: [
            clearTasksItem({
              state: 'ACTIVE',
              assignedOpenCount: 9,
              unassignedOpenCount: 0,
              dueTodayRelevantCount: 0,
              overdueRelevantCount: 0,
            }),
            clearSuppliesItem(),
            clearMaintenanceItem(),
          ],
        }),
      },
      pulseDelayMs: 60,
      delayedHomeId: TEST_HOME_B,
    });
    const { router, queryClient } = renderApp(`/homes/${TEST_HOME_A}`);

    expect(await screen.findByText('Assigned to you: 2')).toBeInTheDocument();
    expect(queryClient.getQueryData(pulseKeys.all(TEST_HOME_A))).toEqual(
      activeHousePulse(),
    );

    await router.navigate(`/homes/${TEST_HOME_B}`);

    await waitFor(() => {
      expect(screen.queryByText('Assigned to you: 2')).not.toBeInTheDocument();
    });
    expect(
      await screen.findByRole('heading', { name: 'Cedar House', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Assigned to you: 9')).toBeInTheDocument();
    expect(queryClient.getQueryData(pulseKeys.all(TEST_HOME_B))).toBeDefined();
    expect(pulseKeys.all(TEST_HOME_B)).toEqual(['home', TEST_HOME_B, 'pulse']);

    await router.navigate(`/homes/${TEST_HOME_A}`);
    expect(await screen.findByText('Assigned to you: 2')).toBeInTheDocument();
  });

  it('clears Pulse with private Home cache on auth loss path', async () => {
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: activeHousePulse() },
    });
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}`);
    expect(await screen.findByTestId('house-pulse')).toBeInTheDocument();
    expect(queryClient.getQueryData(pulseKeys.all(TEST_HOME_A))).toBeDefined();

    clearPrivateHomeQueryState(queryClient);
    void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });

    expect(
      queryClient.getQueryData(pulseKeys.all(TEST_HOME_A)),
    ).toBeUndefined();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('does not invent Supplies destinations', async () => {
    stubPulseApis({
      pulseByHome: { [TEST_HOME_A]: activeHousePulse() },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    const region = await screen.findByTestId('house-pulse');
    expect(
      within(region).getByRole('link', { name: 'Open Tasks' }),
    ).toBeInTheDocument();
    expect(
      within(region).queryByRole('link', { name: /supplies/i }),
    ).not.toBeInTheDocument();
  });
});
