import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { holdMatchingFetches } from '../test/hold-matching-fetch.js';
import { renderApp } from '../test/render.js';
import { activityKeys } from './activity-query-keys.js';
import {
  FIXTURE_TASK_TITLED,
  listPage,
  TEST_HOME_A,
} from './test-fixtures.js';
import { stubActivityApis } from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function isHomeActivityList(url: URL, method: string): boolean {
  return (
    method === 'GET' &&
    /^\/api\/v1\/homes\/[^/]+\/activity$/i.test(url.pathname)
  );
}

describe('Home Activity preview', () => {
  it('shows an announced skeleton on initial load, not the empty state', async () => {
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([]),
      },
    });
    const hold = holdMatchingFetches(fetchMock, isHomeActivityList, {
      fromCall: 1,
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    const feed = await screen.findByRole('region', { name: 'Activity' });
    expect(
      await within(feed).findByRole('status', { name: 'Loading' }),
    ).toBeInTheDocument();
    expect(
      within(feed).queryByRole('heading', { name: 'Nothing here yet.' }),
    ).not.toBeInTheDocument();

    hold.releaseHold();
    expect(
      await within(feed).findByRole('heading', {
        name: 'Nothing here yet.',
        level: 2,
      }),
    ).toBeInTheDocument();
  });

  it('keeps the empty copy visible during a background refetch', async () => {
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([]),
      },
    });
    const hold = holdMatchingFetches(fetchMock, isHomeActivityList);
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}`);

    const feed = await screen.findByRole('region', { name: 'Activity' });
    expect(
      await within(feed).findByRole('heading', {
        name: 'Nothing here yet.',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      within(feed).getByText('Household activity will show up here.'),
    ).toBeInTheDocument();

    void queryClient.invalidateQueries({
      queryKey: activityKeys.list(TEST_HOME_A),
    });
    await waitFor(() => {
      expect(hold.matchingCalls).toBeGreaterThan(1);
    });

    expect(
      within(feed).getByRole('heading', {
        name: 'Nothing here yet.',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      within(feed).getByText('Household activity will show up here.'),
    ).toBeInTheDocument();
    expect(
      within(feed).queryByRole('list', { name: 'Home activity' }),
    ).not.toBeInTheDocument();
    expect(
      within(feed).queryByRole('status', { name: 'Loading' }),
    ).not.toBeInTheDocument();

    hold.releaseHold();
  });

  it('keeps existing preview rows visible during a background refetch', async () => {
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED]),
      },
    });
    const hold = holdMatchingFetches(fetchMock, isHomeActivityList);
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}`);

    const feed = await screen.findByRole('region', { name: 'Activity' });
    expect(
      await within(feed).findByText('Take out trash'),
    ).toBeInTheDocument();

    void queryClient.invalidateQueries({
      queryKey: activityKeys.list(TEST_HOME_A),
    });
    await waitFor(() => {
      expect(hold.matchingCalls).toBeGreaterThan(1);
    });

    expect(within(feed).getByText('Take out trash')).toBeInTheDocument();
    expect(
      within(feed).getByRole('list', { name: 'Home activity' }),
    ).toBeInTheDocument();
    expect(
      within(feed).queryByRole('heading', { name: 'Nothing here yet.' }),
    ).not.toBeInTheDocument();
    expect(
      within(feed).queryByRole('status', { name: 'Loading' }),
    ).not.toBeInTheDocument();

    hold.releaseHold();
  });
});
