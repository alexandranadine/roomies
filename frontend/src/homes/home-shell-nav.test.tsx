import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { stubPulseApis } from '../pulse/test-stub.js';
import { TEST_HOME_A } from '../pulse/test-fixtures.js';
import { stubRoommatesApis, TEST_HOME_A as ROOMMATE_HOME } from '../roommates/test-stub.js';
import { renderApp } from '../test/render.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Home shell navigation', () => {
  it('exposes Home, Tasks, Roommates, and Account destinations', async () => {
    stubPulseApis();
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      `/homes/${TEST_HOME_A}`,
    );
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute(
      'href',
      `/homes/${TEST_HOME_A}/tasks`,
    );
    const roommatesLink = screen.getByRole('link', { name: 'Roommates' });
    expect(roommatesLink).toHaveAttribute(
      'href',
      `/homes/${TEST_HOME_A}/roommates`,
    );
    expect(roommatesLink).toHaveTextContent('Roommates');
    const accountLink = screen.getByRole('link', { name: 'Account' });
    expect(accountLink).toHaveAttribute('href', '/account');
    expect(accountLink).toHaveTextContent('Account');
    expect(
      screen.getByRole('link', { name: 'Notifications' }),
    ).toHaveAttribute('href', '/notifications');
    expect(router.state.location.pathname).toBe(`/homes/${TEST_HOME_A}`);
  });

  it('marks Tasks as the current destination beyond color', async () => {
    stubPulseApis();
    const { router } = renderApp(`/homes/${TEST_HOME_A}/tasks`);
    expect(await screen.findByRole('link', { name: 'Tasks' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute(
      'aria-current',
    );
    expect(
      screen.getByRole('link', { name: 'Notifications' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/homes/${TEST_HOME_A}/tasks`);
  });

  it('opens allowed center + actions for an Admin and hides them from a Roommate', async () => {
    stubRoommatesApis({ role: 'ADMIN' });
    renderApp(`/homes/${ROOMMATE_HOME}`);
    await screen.findByRole('heading', { name: 'Oak Street', level: 1 });

    await userEvent.click(
      screen.getByRole('button', { name: 'Add to this Home' }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Add to this Home' });
    expect(
      within(sheet).getByRole('button', { name: 'Add task' }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: 'Invite roommate' }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: 'Add Home photo' }),
    ).toBeInTheDocument();
    expect(
      within(sheet).queryByRole('button', { name: /post|event|supplies/i }),
    ).toBeNull();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Add to this Home' }),
      ).not.toBeInTheDocument();
    });
  });

  it('opens the center + menu from the keyboard', async () => {
    stubPulseApis();
    renderApp(`/homes/${TEST_HOME_A}`);
    const add = await screen.findByRole('button', { name: 'Add to this Home' });
    add.focus();
    expect(add).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(
      await screen.findByRole('dialog', { name: 'Add to this Home' }),
    ).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Add to this Home' }),
      ).not.toBeInTheDocument();
    });
  });

  it('hides Invite from the center + sheet for a Roommate', async () => {
    stubRoommatesApis({ role: 'ROOMMATE' });
    renderApp(`/homes/${ROOMMATE_HOME}`);
    await screen.findByRole('heading', { name: 'Oak Street', level: 1 });

    await userEvent.click(
      screen.getByRole('button', { name: 'Add to this Home' }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Add to this Home' });
    expect(
      within(sheet).getByRole('button', { name: 'Add task' }),
    ).toBeInTheDocument();
    expect(
      within(sheet).queryByRole('button', { name: 'Invite roommate' }),
    ).not.toBeInTheDocument();
  });
});
