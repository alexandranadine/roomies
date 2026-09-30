import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import {
  defaultCreatedInvitation,
  jsonResponse,
  stubRoommatesApis,
  TEST_HOME_A,
  TEST_HOME_B,
} from '../roommates/test-stub.js';
import { renderApp } from '../test/render.js';

const INVITE_SECRET = 'test-secret';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

function assertSecretNotPersisted() {
  expect(JSON.stringify(localStorage)).not.toContain(INVITE_SECRET);
  expect(JSON.stringify(sessionStorage)).not.toContain(INVITE_SECRET);
}

async function createInviteFromRoommates(user: ReturnType<typeof userEvent.setup>) {
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
  await within(dialog).findByText(/Invitation created/i);
  await user.click(within(dialog).getByRole('button', { name: 'Done' }));
  await waitFor(() => {
    expect(
      screen.queryByRole('dialog', { name: 'Invite roommate' }),
    ).not.toBeInTheDocument();
  });
}

async function createInviteFromActionSheet(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(
    await screen.findByRole('button', { name: 'What needs doing?' }),
  );
  const sheet = await screen.findByRole('dialog', { name: 'Add to this Home' });
  await user.click(
    within(sheet).getByRole('button', { name: 'Invite roommate' }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Invite roommate',
  });
  await user.type(within(dialog).getByLabelText(/email/i), 'jamie@example.com');
  await user.click(
    within(dialog).getByRole('button', { name: 'Send invitation' }),
  );
  await within(dialog).findByText(/Invitation created/i);
  await user.click(within(dialog).getByRole('button', { name: 'Done' }));
  await waitFor(() => {
    expect(
      screen.queryByRole('dialog', { name: 'Invite roommate' }),
    ).not.toBeInTheDocument();
  });
}

describe('Home latest invite recovery', () => {
  it('keeps the latest invite recoverable on Roommates after closing the dialog', async () => {
    const user = userEvent.setup();
    const created = defaultCreatedInvitation();
    stubRoommatesApis({
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await createInviteFromRoommates(user);

    expect(screen.getByText(/Latest invite/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invite link/i)).toHaveValue(created.inviteUrl);
    expect(
      screen.getByRole('button', { name: 'View invite link' }),
    ).toBeInTheDocument();
    assertSecretNotPersisted();
  });

  it('keeps the latest invite recoverable from the Home action sheet after creation', async () => {
    const user = userEvent.setup();
    const created = defaultCreatedInvitation();
    stubRoommatesApis({
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    await createInviteFromActionSheet(user);

    await user.click(
      screen.getByRole('button', { name: 'What needs doing?' }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'Add to this Home',
    });
    expect(
      within(sheet).getByRole('button', { name: 'View latest invite' }),
    ).toBeInTheDocument();

    await user.click(
      within(sheet).getByRole('button', { name: 'View latest invite' }),
    );
    const latestDialog = await screen.findByRole('dialog', {
      name: 'Latest invite',
    });
    expect(within(latestDialog).getByLabelText(/invite link/i)).toHaveValue(
      created.inviteUrl,
    );
    assertSecretNotPersisted();
  });

  it('shares one Home-scoped latest invite across Roommates and the action sheet', async () => {
    const user = userEvent.setup();
    const created = defaultCreatedInvitation();
    stubRoommatesApis({
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await createInviteFromRoommates(user);

    await user.click(screen.getByRole('link', { name: 'Home' }));
    await screen.findByRole('button', { name: 'What needs doing?' });

    await user.click(
      screen.getByRole('button', { name: 'What needs doing?' }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'Add to this Home',
    });
    await user.click(
      within(sheet).getByRole('button', { name: 'View latest invite' }),
    );
    const latestDialog = await screen.findByRole('dialog', {
      name: 'Latest invite',
    });
    expect(within(latestDialog).getByLabelText(/invite link/i)).toHaveValue(
      created.inviteUrl,
    );
  });

  it('clears the latest invite when switching Homes', async () => {
    const user = userEvent.setup();
    const created = defaultCreatedInvitation();
    stubRoommatesApis({
      homes: [
        {
          id: TEST_HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          role: 'ADMIN',
          hasPhoto: false,
        },
        {
          id: TEST_HOME_B,
          name: 'Cedar House',
          timezone: 'UTC',
          role: 'ADMIN',
          hasPhoto: false,
        },
      ],
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await createInviteFromRoommates(user);
    expect(screen.getByText(/Latest invite/i)).toBeInTheDocument();

    await router.navigate(`/homes/${TEST_HOME_B}`);
    await screen.findByRole('heading', { name: 'Cedar House', level: 1 });

    expect(screen.queryByText(/Latest invite/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'View invite link' }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Add to this Home' }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'Add to this Home',
    });
    expect(
      within(sheet).queryByRole('button', { name: 'View latest invite' }),
    ).not.toBeInTheDocument();
  });

  it('hides recovery UI for non-admin users', async () => {
    stubRoommatesApis({ role: 'ROOMMATE' });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await screen.findByRole('heading', { name: 'Roommates', level: 1 });

    expect(
      screen.queryByRole('button', { name: 'Invite roommate' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'View invite link' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Latest invite/i)).not.toBeInTheDocument();
  });

  it('clears latest invite access after self-demotion from Admin', async () => {
    const user = userEvent.setup();
    const created = defaultCreatedInvitation();
    stubRoommatesApis({
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await createInviteFromRoommates(user);
    expect(screen.getByText(/Latest invite/i)).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Actions for Alex' }),
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Make roommate' }),
    );

    await waitFor(() => {
      expect(screen.queryByText(/Latest invite/i)).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: 'View invite link' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Invite roommate' }),
    ).not.toBeInTheDocument();
  });

  it('does not write invite secrets to browser storage or logs', async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const created = defaultCreatedInvitation();
    stubRoommatesApis({
      handlers: {
        createInvitation: () => jsonResponse(201, created),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/roommates`);

    await createInviteFromRoommates(user);

    assertSecretNotPersisted();
    for (const call of consoleSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(INVITE_SECRET);
    }
  });
});
