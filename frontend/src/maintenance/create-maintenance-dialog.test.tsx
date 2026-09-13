import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homeMembershipsKeys } from '../homes/home-memberships-query-keys.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import { maintenanceKeys } from './maintenance-query-keys.js';
import {
  detailFromListItem,
  FIXTURE_H,
  listPage,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_MEMBERSHIP_A,
  TEST_MEMBERSHIP_B,
} from './test-fixtures.js';
import { stubMaintenanceApis } from './test-stub.js';

const CREATED_ID = 'c1111111-1111-4111-8111-111111111111';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openCreateDialog() {
  await userEvent.click(
    await screen.findByRole('button', { name: 'Add maintenance' }),
  );
  const dialog = await screen.findByRole('dialog');
  expect(
    await within(dialog).findByRole('textbox', { name: /title/i }),
  ).toBeInTheDocument();
  return dialog;
}

function lastCreateBody(fetchMock: ReturnType<typeof stubMaintenanceApis>) {
  const createCalls = fetchMock.mock.calls.filter((call) => {
    const url = String(call[0]);
    const init = call[1] as RequestInit | undefined;
    return (
      url.includes(`/homes/${TEST_HOME_A}/maintenance`) &&
      !url.includes('/memberships') &&
      (init?.method ?? 'GET').toUpperCase() === 'POST' &&
      !url.includes('/resolve')
    );
  });
  const last = createCalls[createCalls.length - 1];
  expect(last).toBeDefined();
  const body = (last?.[1] as RequestInit | undefined)?.body;
  expect(typeof body).toBe('string');
  return JSON.parse(body as string) as Record<string, unknown>;
}

describe('Maintenance create UI', () => {
  it('opens create UI from Add maintenance', async () => {
    stubMaintenanceApis({
      listByHome: { [TEST_HOME_A]: listPage([FIXTURE_H]) },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    expect(screen.getByRole('textbox', { name: /title/i })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /details/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Visibility')).toBeInTheDocument();
  });

  it('requires a non-whitespace title and caps at 120', async () => {
    stubMaintenanceApis();
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    const dialog = await openCreateDialog();

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );
    expect(await screen.findByText('Enter a title.')).toBeInTheDocument();

    const title = within(dialog).getByRole('textbox', { name: /title/i });
    expect(title).toHaveAttribute('maxLength', '120');
  });

  it('allows optional details (maxLength 4000 enforced on control)', async () => {
    const fetchMock = stubMaintenanceApis({
      createByHome: {
        [TEST_HOME_A]: detailFromListItem(
          { ...FIXTURE_H, id: CREATED_ID, title: 'Ok' },
          null,
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    const dialog = screen.getByRole('dialog');

    const details = within(dialog).getByRole('textbox', { name: /details/i });
    expect(details).toHaveAttribute('maxLength', '4000');

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Ok',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(lastCreateBody(fetchMock)).not.toHaveProperty('details');
  });

  it('submits HOUSEHOLD without audienceMembershipIds', async () => {
    const fetchMock = stubMaintenanceApis({
      createByHome: {
        [TEST_HOME_A]: (body) => {
          expect(body).not.toHaveProperty('audienceMembershipIds');
          return detailFromListItem(
            { ...FIXTURE_H, id: CREATED_ID, title: 'Household note' },
            null,
          );
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    const dialog = screen.getByRole('dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Household note',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );
    await waitFor(() => {
      expect(lastCreateBody(fetchMock)).toEqual({
        visibility: 'HOUSEHOLD',
        title: 'Household note',
      });
    });
  });

  it('does not send audienceMembershipIds after switching PRIVATE→HOUSEHOLD', async () => {
    const fetchMock = stubMaintenanceApis({
      createByHome: {
        [TEST_HOME_A]: detailFromListItem(
          { ...FIXTURE_H, id: CREATED_ID, title: 'Switched' },
          null,
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    const dialog = screen.getByRole('dialog');

    await userEvent.click(
      within(dialog).getByRole('radio', { name: /Private/i }),
    );
    await screen.findByText('You’re included automatically.');
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Jamie' }),
    );
    await userEvent.click(
      within(dialog).getByRole('radio', { name: /Household/i }),
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Switched',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );

    await waitFor(() => {
      const body = lastCreateBody(fetchMock);
      expect(body.visibility).toBe('HOUSEHOLD');
      expect(body).not.toHaveProperty('audienceMembershipIds');
    });
  });

  it('allows PRIVATE [] creator-only and explains automatic inclusion', async () => {
    const fetchMock = stubMaintenanceApis({
      membershipsByHome: {
        [TEST_HOME_A]: {
          currentMembershipId: TEST_MEMBERSHIP_A,
          memberships: [
            { membershipId: TEST_MEMBERSHIP_A, name: 'Alex' },
            { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
          ],
        },
      },
      createByHome: {
        [TEST_HOME_A]: detailFromListItem(
          {
            ...FIXTURE_H,
            id: CREATED_ID,
            title: 'Solo',
            visibility: 'PRIVATE',
          },
          null,
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    const dialog = screen.getByRole('dialog');

    await userEvent.click(
      within(dialog).getByRole('radio', { name: /Private/i }),
    );
    expect(
      screen.getByText('You’re included automatically.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /If you don’t choose anyone, only you will be able to see this/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Alex' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Jamie' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TEST_MEMBERSHIP_A);
    expect(document.body.textContent).not.toContain(TEST_MEMBERSHIP_B);

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Solo',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );

    await waitFor(() => {
      expect(lastCreateBody(fetchMock)).toEqual({
        visibility: 'PRIVATE',
        title: 'Solo',
        audienceMembershipIds: [],
      });
    });
  });

  it('submits selected recipient membershipId values and never shows raw IDs', async () => {
    const fetchMock = stubMaintenanceApis({
      createByHome: {
        [TEST_HOME_A]: detailFromListItem(
          {
            ...FIXTURE_H,
            id: CREATED_ID,
            title: 'Shared',
            visibility: 'PRIVATE',
          },
          null,
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    const dialog = screen.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('radio', { name: /Private/i }),
    );
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Jamie' }),
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Shared',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );

    await waitFor(() => {
      expect(lastCreateBody(fetchMock)).toEqual({
        visibility: 'PRIVATE',
        title: 'Shared',
        audienceMembershipIds: [TEST_MEMBERSHIP_B],
      });
    });
    expect(document.body.textContent).not.toContain(TEST_MEMBERSHIP_B);
  });

  it('supports creator-only when memberships contains only the current actor', async () => {
    const fetchMock = stubMaintenanceApis({
      membershipsByHome: {
        [TEST_HOME_A]: {
          currentMembershipId: TEST_MEMBERSHIP_A,
          memberships: [{ membershipId: TEST_MEMBERSHIP_A, name: 'Alex' }],
        },
      },
      createByHome: {
        [TEST_HOME_A]: detailFromListItem(
          {
            ...FIXTURE_H,
            id: CREATED_ID,
            title: 'Alone',
            visibility: 'PRIVATE',
          },
          null,
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    const dialog = screen.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('radio', { name: /Private/i }),
    );

    expect(
      screen.getByText(
        'No other roommates to add. This will be visible only to you.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Alone',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );
    await waitFor(() => {
      expect(lastCreateBody(fetchMock)).toEqual({
        visibility: 'PRIVATE',
        title: 'Alone',
        audienceMembershipIds: [],
      });
    });
  });

  it('does not masquerade memberships 404 as an empty roommate list', async () => {
    stubMaintenanceApis({
      membershipsByHome: {
        [TEST_HOME_A]: { status: 404, body: notFoundBody() },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    const dialog = screen.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('radio', { name: /Private/i }),
    );

    expect(await screen.findByText(/Home unavailable/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/No other roommates to add/),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    ).toBeDisabled();
  });

  it('preserves draft on create failure and closes on success', async () => {
    const fetchMock = stubMaintenanceApis({
      createByHome: {
        [TEST_HOME_A]: {
          status: 400,
          body: {
            error: { code: 'INVALID_REQUEST', message: 'bad' },
          },
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    const dialog = screen.getByRole('dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Keep me',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /details/i }),
      'Draft notes',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );
    expect(
      await screen.findByText(/Couldn’t create this item/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /title/i })).toHaveValue(
      'Keep me',
    );
    expect(
      within(dialog).getByRole('textbox', { name: /details/i }),
    ).toHaveValue('Draft notes');
    expect(lastCreateBody(fetchMock).title).toBe('Keep me');
  });

  it('invalidates same-Home list cache only and has no Admin PRIVATE special case', async () => {
    const created = detailFromListItem(
      { ...FIXTURE_H, id: CREATED_ID, title: 'Created' },
      null,
    );
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_H]),
        [TEST_HOME_B]: listPage([]),
      },
      createByHome: { [TEST_HOME_A]: created },
    });
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await screen.findByText('Replace furnace filter');

    // Seed other-home list so we can assert it stays untouched.
    await queryClient.fetchQuery({
      queryKey: maintenanceKeys.list(TEST_HOME_B, {}),
      queryFn: () => Promise.resolve(listPage([])),
    });
    const otherBefore = queryClient.getQueryState(
      maintenanceKeys.list(TEST_HOME_B, {}),
    )?.dataUpdatedAt;

    await openCreateDialog();
    const dialog = screen.getByRole('dialog');
    expect(
      screen.queryAllByText(/admin|landlord|owner override/i),
    ).toHaveLength(0);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Created',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add maintenance' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(
      queryClient.getQueryData(maintenanceKeys.detail(TEST_HOME_A, CREATED_ID)),
    ).toEqual(created);
    expect(
      queryClient.getQueryState(maintenanceKeys.list(TEST_HOME_B, {}))
        ?.dataUpdatedAt,
    ).toBe(otherBefore);
  });

  it('isolates memberships cache across Homes and switches queries', async () => {
    stubMaintenanceApis({
      membershipsByHome: {
        [TEST_HOME_A]: {
          currentMembershipId: TEST_MEMBERSHIP_A,
          memberships: [
            { membershipId: TEST_MEMBERSHIP_A, name: 'Alex' },
            { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
          ],
        },
        [TEST_HOME_B]: {
          currentMembershipId: TEST_MEMBERSHIP_B,
          memberships: [
            { membershipId: TEST_MEMBERSHIP_B, name: 'Casey' },
            {
              membershipId: 'm3333333-3333-4333-8333-333333333333',
              name: 'Drew',
            },
          ],
        },
      },
    });
    const { queryClient, router } = renderApp(
      `/homes/${TEST_HOME_A}/maintenance`,
    );
    await openCreateDialog();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('radio', {
        name: /Private/i,
      }),
    );
    await screen.findByRole('checkbox', { name: 'Jamie' });

    expect(
      queryClient.getQueryData(homeMembershipsKeys.all(TEST_HOME_A)),
    ).toBeTruthy();
    expect(
      queryClient.getQueryData(homeMembershipsKeys.all(TEST_HOME_B)),
    ).toBeUndefined();

    await router.navigate(`/homes/${TEST_HOME_B}/maintenance`);
    await screen.findByRole('heading', { name: 'Maintenance', level: 1 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await openCreateDialog();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('radio', {
        name: /Private/i,
      }),
    );
    expect(
      await screen.findByRole('checkbox', { name: 'Drew' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Jamie' }),
    ).not.toBeInTheDocument();
    expect(
      queryClient.getQueryData(homeMembershipsKeys.all(TEST_HOME_B)),
    ).toBeTruthy();
  });

  it('does not implement client-side ended-tenure filtering', async () => {
    // Backend already returns active-only; UI renders the projection as-is.
    stubMaintenanceApis({
      membershipsByHome: {
        [TEST_HOME_A]: {
          currentMembershipId: TEST_MEMBERSHIP_A,
          memberships: [
            { membershipId: TEST_MEMBERSHIP_A, name: 'Alex' },
            { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
          ],
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);
    await openCreateDialog();
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('radio', {
        name: /Private/i,
      }),
    );
    expect(screen.getByRole('checkbox', { name: 'Jamie' })).toBeInTheDocument();
    expect(screen.queryAllByText(/ended|inactive|historical/i)).toHaveLength(0);
  });
});
