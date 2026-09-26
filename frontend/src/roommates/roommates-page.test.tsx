import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homeMembershipsKeys } from '../homes/home-memberships-query-keys.js';
import {
  currentUserHomesQueryKey,
  homeContextQueryKey,
} from '../homes/home-query-keys.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { renderApp } from '../test/render.js';
import {
  CURRENT_MEMBERSHIP_ID,
  defaultCreatedInvitation,
  defaultMemberships,
  emptyResponse,
  ENDED_MEMBERSHIP_ID,
  errorBody,
  INVITATION_ID,
  jsonResponse,
  OTHER_MEMBERSHIP_ID,
  REJOIN_MEMBERSHIP_ID,
  stubRoommatesApis,
  TEST_HOME_A,
  TEST_USER_ID,
} from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function assertNoInternalIds() {
  const text = document.body.textContent ?? '';
  const html = document.body.innerHTML;
  for (const id of [
    CURRENT_MEMBERSHIP_ID,
    OTHER_MEMBERSHIP_ID,
    ENDED_MEMBERSHIP_ID,
    REJOIN_MEMBERSHIP_ID,
    TEST_USER_ID,
  ]) {
    expect(text).not.toContain(id);
    expect(html).not.toContain(id);
  }
  expect(text).not.toMatch(/\bADMIN\b|\bROOMMATE\b/);
  expect(text).not.toMatch(/owner|membership/i);
}

async function openRowActions(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  expect(await screen.findByRole('menu')).toBeInTheDocument();
}

describe('Roommates page', () => {
  it('reaches Roommates from Home navigation and lists active roommates only', async () => {
    const user = userEvent.setup();
    stubRoommatesApis();
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('link', { name: 'Roommates' }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Roommates', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/homes/${TEST_HOME_A}/roommates`,
    );
    expect(await screen.findByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Jamie')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Home Admin')).toBeInTheDocument();
    expect(screen.getByText('Household member')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2 roommates' })).toBeInTheDocument();
    expect(screen.queryByText('Morgan')).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Alex (you)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Jamie' })).toBeInTheDocument();
    assertNoInternalIds();
  });

  it('excludes ended tenures and uses only the new active tenure after rejoin', async () => {
    stubRoommatesApis({
      role: 'ROOMMATE',
      memberships: {
        currentMembershipId: REJOIN_MEMBERSHIP_ID,
        memberships: [
          { membershipId: REJOIN_MEMBERSHIP_ID, name: 'Alex' },
          { membershipId: OTHER_MEMBERSHIP_ID, name: 'Jamie' },
        ],
      },
    });
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}/roommates`);
    queryClient.setQueryData(homeMembershipsKeys.all(TEST_HOME_A), {
      currentMembershipId: ENDED_MEMBERSHIP_ID,
      memberships: [
        { membershipId: ENDED_MEMBERSHIP_ID, name: 'Alex' },
        { membershipId: OTHER_MEMBERSHIP_ID, name: 'Morgan' },
      ],
    });
    await queryClient.invalidateQueries({
      queryKey: homeMembershipsKeys.all(TEST_HOME_A),
    });

    expect(await screen.findByText('Jamie')).toBeInTheDocument();
    expect(screen.getAllByText('Alex').length).toBeGreaterThan(0);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('Morgan')).not.toBeInTheDocument();
    assertNoInternalIds();
  });

  it('renders a one-person Home without looking empty', async () => {
    stubRoommatesApis({
      memberships: {
        currentMembershipId: CURRENT_MEMBERSHIP_ID,
        memberships: [{ membershipId: CURRENT_MEMBERSHIP_ID, name: 'Alex' }],
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(await screen.findByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('It’s just you here for now.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Invite roommate' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1 roommate' })).toBeInTheDocument();
    expect(screen.queryByText('Jamie')).not.toBeInTheDocument();
    assertNoInternalIds();
  });

  it('wraps a long display name without rendering ids', async () => {
    stubRoommatesApis({
      memberships: {
        currentMembershipId: CURRENT_MEMBERSHIP_ID,
        memberships: [
          {
            membershipId: CURRENT_MEMBERSHIP_ID,
            name: 'Alexandra Nadine Lewis',
          },
          { membershipId: OTHER_MEMBERSHIP_ID, name: 'Jamie' },
        ],
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(
      await screen.findByText('Alexandra Nadine Lewis'),
    ).toBeInTheDocument();
    expect(screen.getByText('Jamie')).toBeInTheDocument();
    assertNoInternalIds();
  });
});

describe('Roommates ROOMMATE UI', () => {
  it('can view roommates without Admin structural controls and can leave', async () => {
    stubRoommatesApis({ role: 'ROOMMATE' });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(await screen.findByText('Jamie')).toBeInTheDocument();
    expect(screen.getByText('Roommate')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Invite roommate' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Jamie' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Alex' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Make admin' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Remove from Home' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Leave Home' }),
    ).toBeInTheDocument();
    assertNoInternalIds();
  });
});

describe('Roommates ADMIN UI', () => {
  it('shows invite, role-change, remove, and leave actions', async () => {
    const user = userEvent.setup();
    stubRoommatesApis({ role: 'ADMIN' });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(
      await screen.findByRole('button', { name: 'Invite roommate' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Leave Home' }),
    ).toBeInTheDocument();

    await openRowActions(user, 'Jamie');
    expect(
      screen.getByRole('menuitem', { name: 'Make admin' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Make roommate' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Remove from Home' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await openRowActions(user, 'Alex');
    expect(
      screen.queryByRole('menuitem', { name: 'Remove from Home' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Make roommate' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('creates an invitation using the existing contract and shows the share URL', async () => {
    const user = userEvent.setup();
    const created = defaultCreatedInvitation();
    const { fetchMock } = stubRoommatesApis({
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await user.click(
      await screen.findByRole('button', { name: 'Invite roommate' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Invite roommate',
    });
    const email = within(dialog).getByLabelText(/email/i);
    await user.type(email, 'Jamie@Example.com');
    await user.click(
      within(dialog).getByRole('button', { name: 'Send invitation' }),
    );

    expect(
      await within(dialog).findByText(/Invitation created/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/invite link/i)).toHaveValue(
      created.inviteUrl,
    );
    const inviteCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/invitations'),
    ) as [string, RequestInit] | undefined;
    expect(inviteCall).toBeDefined();
    expect(inviteCall?.[1].body).toBe(
      JSON.stringify({ email: 'jamie@example.com' }),
    );
  });

  it('shows a compact pending invite panel and revokes through the existing contract', async () => {
    const user = userEvent.setup();
    const created = defaultCreatedInvitation();
    const { fetchMock } = stubRoommatesApis({
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await user.click(
      await screen.findByRole('button', { name: 'Invite roommate' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Invite roommate',
    });
    await user.type(within(dialog).getByLabelText(/email/i), 'jamie@example.com');
    await user.click(
      within(dialog).getByRole('button', { name: 'Send invitation' }),
    );
    expect(
      await within(dialog).findByText(/Invitation created/i),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Invite roommate' })).not.toBeInTheDocument();
    });

    expect(screen.getByText(/Invite pending/i)).toBeInTheDocument();
    expect(screen.getByText(/jamie@example.com/i)).toBeInTheDocument();
    const link = screen.getByLabelText(/invite link/i);
    expect(link).toHaveValue(created.inviteUrl);
    expect(
      screen.getByRole('button', { name: 'Copy invite link' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke invite' }));
    const revokeDialog = await screen.findByRole('dialog', {
      name: 'Revoke invite?',
    });
    await user.click(
      within(revokeDialog).getByRole('button', { name: 'Revoke invite' }),
    );

    await waitFor(() => {
      expect(screen.queryByText(/Invite pending/i)).not.toBeInTheDocument();
    });
    const revokeCall = fetchMock.mock.calls.find(([url, init]) => {
      return (
        String(url).includes(`/invitations/${INVITATION_ID}/revoke`) &&
        (init as RequestInit | undefined)?.method === 'POST'
      );
    });
    expect(revokeCall).toBeDefined();
    expect(document.body.textContent).not.toContain(INVITATION_ID);
  });
});

describe('Roommates mutation responsiveness', () => {
  it('settles invite dialog without waiting for /me/homes refetch', async () => {
    let homesFetchCount = 0;
    let releaseHomesRefetch: ((response: Response) => void) | undefined;
    let homesRefetchPending = false;
    const created = defaultCreatedInvitation();
    const { fetchMock } = stubRoommatesApis({
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const path = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (path.endsWith('/api/v1/me/homes') && method === 'GET') {
        homesFetchCount += 1;
        const response = jsonResponse(200, [
          {
            id: TEST_HOME_A,
            name: 'Oak Street',
            timezone: 'UTC',
            hasPhoto: false,
            role: 'ADMIN',
          },
        ]);
        if (homesFetchCount > 1) {
          homesRefetchPending = true;
          return new Promise<Response>((resolve) => {
            releaseHomesRefetch = resolve;
          });
        }
        return Promise.resolve(response);
      }

      return baseFetch?.(input, init) ?? Promise.resolve(new Response(null, { status: 404 }));
    });

    const user = userEvent.setup();
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await user.click(
      await screen.findByRole('button', { name: 'Invite roommate' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Invite roommate',
    });
    await user.type(within(dialog).getByLabelText(/email/i), 'jamie@example.com');
    await user.click(
      within(dialog).getByRole('button', { name: 'Send invitation' }),
    );

    expect(
      await within(dialog).findByText(/Invitation created/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Copy invite link' }),
    ).not.toBeDisabled();
    expect(homesFetchCount).toBeGreaterThanOrEqual(1);
    expect(homesRefetchPending).toBe(true);

    releaseHomesRefetch?.(
      jsonResponse(200, [
        {
          id: TEST_HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          hasPhoto: false,
          role: 'ADMIN',
        },
      ]),
    );
  });

  it('settles remove dialog without waiting for memberships refetch', async () => {
    let membershipsFetchCount = 0;
    let releaseMembershipsRefetch: ((response: Response) => void) | undefined;
    let membershipsRefetchPending = false;

    const { fetchMock } = stubRoommatesApis();
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const path = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (
        path.endsWith(`/api/v1/homes/${TEST_HOME_A}/memberships`) &&
        method === 'GET'
      ) {
        membershipsFetchCount += 1;
        const response = jsonResponse(200, defaultMemberships());
        if (membershipsFetchCount > 1) {
          membershipsRefetchPending = true;
          return new Promise<Response>((resolve) => {
            releaseMembershipsRefetch = resolve;
          });
        }
        return Promise.resolve(response);
      }

      return baseFetch?.(input, init) ?? Promise.resolve(new Response(null, { status: 404 }));
    });

    const user = userEvent.setup();
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(await screen.findByText('Jamie')).toBeInTheDocument();
    await openRowActions(user, 'Jamie');
    await user.click(
      screen.getByRole('menuitem', { name: 'Remove from Home' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'Remove from Home',
    });
    await user.click(
      within(dialog).getByRole('button', { name: 'Remove from Home' }),
    );

    await waitFor(() => {
      expect(screen.queryByText('Jamie')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog', { name: 'Remove from Home' })).toBeNull();
    expect(membershipsFetchCount).toBe(2);
    expect(membershipsRefetchPending).toBe(true);

    releaseMembershipsRefetch?.(
      jsonResponse(200, {
        currentMembershipId: CURRENT_MEMBERSHIP_ID,
        memberships: [{ membershipId: CURRENT_MEMBERSHIP_ID, name: 'Alex' }],
      }),
    );
  });
});

describe('Roommates role change', () => {
  it('refreshes Home role after a successful self demotion and does not escalate early', async () => {
    let resolveRole: ((value: Response) => void) | undefined;
    const { state } = stubRoommatesApis({
      role: 'ADMIN',
      handlers: {
        changeRole: () =>
          new Promise<Response>((resolve) => {
            resolveRole = resolve;
          }),
      },
    });
    const user = userEvent.setup();
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(
      await screen.findByRole('button', { name: 'Invite roommate' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Alex')).toBeInTheDocument();

    await openRowActions(user, 'Alex');
    await user.click(screen.getByRole('menuitem', { name: 'Make roommate' }));

    expect(
      screen.getByRole('button', { name: 'Invite roommate' }),
    ).toBeInTheDocument();
    expect(resolveRole).toBeDefined();

    state.role = 'ROOMMATE';
    resolveRole?.(emptyResponse(204));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Invite roommate' }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText('Roommate')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Jamie' }),
    ).not.toBeInTheDocument();
  });

  it('keeps previous Admin state when the backend rejects a role change', async () => {
    stubRoommatesApis({
      role: 'ADMIN',
      handlers: {
        changeRole: () =>
          jsonResponse(
            409,
            errorBody('LAST_ADMIN_REQUIRED', 'Last admin required'),
          ),
      },
    });
    const user = userEvent.setup();
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(
      await screen.findByRole('button', { name: 'Invite roommate' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Jamie')).toBeInTheDocument();

    await openRowActions(user, 'Alex');
    await user.click(screen.getByRole('menuitem', { name: 'Make roommate' }));

    expect(
      await screen.findByText(/needs at least one Home admin/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Invite roommate' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Home Admin')).toBeInTheDocument();
    expect(screen.getByText('Jamie')).toBeInTheDocument();
  });

  it('can promote another roommate without inventing Admin capability for them', async () => {
    const user = userEvent.setup();
    const { fetchMock } = stubRoommatesApis({ role: 'ADMIN' });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(await screen.findByText('Jamie')).toBeInTheDocument();
    await openRowActions(user, 'Jamie');
    await user.click(screen.getByRole('menuitem', { name: 'Make admin' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) => {
          return (
            String(url).includes(`/memberships/${OTHER_MEMBERSHIP_ID}/role`) &&
            (init as RequestInit | undefined)?.method === 'PATCH'
          );
        }),
      ).toBe(true);
    });
    expect(screen.getByText('Jamie')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Invite roommate' }),
    ).toBeInTheDocument();
    assertNoInternalIds();
  });
});

describe('Roommates remove', () => {
  it('requires confirmation, removes the active row on success, and does not claim history is deleted', async () => {
    const user = userEvent.setup();
    stubRoommatesApis();
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(await screen.findByText('Jamie')).toBeInTheDocument();
    await openRowActions(user, 'Jamie');
    await user.click(
      screen.getByRole('menuitem', { name: 'Remove from Home' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'Remove from Home',
    });
    expect(dialog).toHaveTextContent('Jamie');
    expect(dialog).toHaveTextContent(/lose access/i);
    expect(dialog.textContent).not.toMatch(/delet/i);

    await user.click(
      within(dialog).getByRole('button', { name: 'Remove from Home' }),
    );

    await waitFor(() => {
      expect(screen.queryByText('Jamie')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/history was deleted/i);
  });

  it('keeps the roommate visible when removal fails', async () => {
    const user = userEvent.setup();
    stubRoommatesApis({
      handlers: {
        remove: () =>
          jsonResponse(
            409,
            errorBody('LAST_ADMIN_REQUIRED', 'Last admin required'),
          ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(await screen.findByText('Jamie')).toBeInTheDocument();
    await openRowActions(user, 'Jamie');
    await user.click(
      screen.getByRole('menuitem', { name: 'Remove from Home' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Remove from Home' }),
    );

    expect(
      await within(dialog).findByText(/needs at least one Home admin/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Jamie')).toBeInTheDocument();
  });
});

describe('Roommates leave', () => {
  it('requires confirmation, clears private Home queries, and navigates away', async () => {
    const user = userEvent.setup();
    stubRoommatesApis();
    const { queryClient, router } = renderApp(
      `/homes/${TEST_HOME_A}/roommates`,
    );

    expect(
      await screen.findByRole('heading', { name: 'Roommates', level: 1 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Leave Home' }),
    ).toBeInTheDocument();
    queryClient.setQueryData(pulseKeys.all(TEST_HOME_A), clearHousePulse());
    queryClient.setQueryData(homeContextQueryKey(TEST_HOME_A), {
      id: TEST_HOME_A,
      name: 'Oak Street',
      timezone: 'UTC',
      hasPhoto: false,
    });

    await user.click(screen.getByRole('button', { name: 'Leave Home' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave Home' });
    expect(dialog).toHaveTextContent(/lose access/i);
    expect(dialog.textContent).not.toMatch(/disappear|delet/i);

    await user.click(
      within(dialog).getByRole('button', { name: 'Leave Home' }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(
      await screen.findByRole('heading', {
        name: 'Welcome to Roomies',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Roommates' }),
    ).not.toBeInTheDocument();
    expect(
      queryClient.getQueryData(homeContextQueryKey(TEST_HOME_A)),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(pulseKeys.all(TEST_HOME_A)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(currentUserHomesQueryKey)).toEqual([]);
  });

  it('keeps the current Home usable when leave fails', async () => {
    const user = userEvent.setup();
    stubRoommatesApis({
      handlers: {
        leave: () =>
          jsonResponse(
            409,
            errorBody('LAST_ADMIN_REQUIRED', 'Last admin required'),
          ),
      },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(await screen.findByText('Jamie')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave Home' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave Home' });
    await user.click(
      within(dialog).getByRole('button', { name: 'Leave Home' }),
    );

    expect(
      await within(dialog).findByText(/Make another roommate a Home admin/i),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/homes/${TEST_HOME_A}/roommates`,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('heading', { name: 'Roommates', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Jamie')).toBeInTheDocument();
  });

  it('keeps the Home usable when the last roommate must archive instead of leaving', async () => {
    const user = userEvent.setup();
    stubRoommatesApis({
      handlers: {
        leave: () =>
          jsonResponse(
            409,
            errorBody(
              'LAST_ROOMMATE_REQUIRES_ARCHIVE',
              'Last roommate requires archive',
            ),
          ),
      },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}/roommates`);

    expect(await screen.findByText('Jamie')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave Home' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave Home' });
    await user.click(
      within(dialog).getByRole('button', { name: 'Leave Home' }),
    );

    expect(
      await within(dialog).findByText(
        /last roommate in this Home, so it can’t be left this way/i,
      ),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/homes/${TEST_HOME_A}/roommates`,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('heading', { name: 'Roommates', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Jamie')).toBeInTheDocument();
  });
});
