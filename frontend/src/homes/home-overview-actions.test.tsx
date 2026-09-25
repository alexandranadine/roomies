import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_JOINED,
  FIXTURE_LEFT,
  FIXTURE_TASK_TITLED,
  listPage,
  TEST_HOME_A,
  TEST_MEMBERSHIP_ALEX,
  TEST_MEMBERSHIP_JAMIE,
} from '../activity/test-fixtures.js';
import { stubActivityApis } from '../activity/test-stub.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { stubRoommatesApis } from '../roommates/test-stub.js';
import { renderApp } from '../test/render.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Home quick actions and feed', () => {
  it('opens real actions and hides dead Post/Event/Supplies controls for Admins', async () => {
    stubRoommatesApis({ role: 'ADMIN' });
    renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('button', { name: 'What’s on your mind, Roomies?' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Home photo' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /post|event|supplies/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(
      await screen.findByRole('dialog', { name: 'Add task' }),
    ).toBeInTheDocument();
  });

  it('hides Invite for a Roommate and links Roommates instead', async () => {
    stubRoommatesApis({ role: 'ROOMMATE' });
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);
    await screen.findByRole('heading', { name: 'Oak Street', level: 1 });

    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    const roommateTiles = screen.getAllByRole('link', { name: 'Roommates' });
    expect(roommateTiles.length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Home photo' }));
    expect(
      await screen.findByRole('dialog', { name: 'Home photo' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/homes/${TEST_HOME_A}`);
  });

  it('renders existing Activity types as a feed without IDs or former-roommate leaks', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED, FIXTURE_JOINED, FIXTURE_LEFT]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}`);

    const feed = await screen.findByRole('list', { name: 'Home activity' });
    expect(feed).toHaveTextContent('Alex');
    expect(feed).toHaveTextContent('completed a task');
    expect(feed).toHaveTextContent('Take out trash');
    expect(feed).toHaveTextContent('Jamie');
    expect(feed).toHaveTextContent('joined the home');
    expect(feed).toHaveTextContent('left the home');
    expect(feed.textContent).not.toContain(TEST_MEMBERSHIP_ALEX);
    expect(feed.textContent).not.toContain(TEST_MEMBERSHIP_JAMIE);
    expect(feed.textContent).not.toMatch(/kudos|reaction|comment/i);
  });

  it('opens the action sheet from the prompt and supports keyboard dismissal', async () => {
    stubRoommatesApis({ role: 'ADMIN' });
    renderApp(`/homes/${TEST_HOME_A}`);
    await screen.findByRole('button', {
      name: 'What’s on your mind, Roomies?',
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'What’s on your mind, Roomies?' }),
    );
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
});
