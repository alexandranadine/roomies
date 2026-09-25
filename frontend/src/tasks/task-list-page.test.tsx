import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORMER_ROOMMATE_LABEL } from '../activity/activity-copy.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import { taskKeys } from './tasks-query-keys.js';
import {
  FIXTURE_COMPLETED,
  FIXTURE_DEFINITION_DEACTIVATED,
  FIXTURE_DEFINITION_OTHER,
  FIXTURE_DEFINITION_WEEKLY,
  FIXTURE_HOME_B_TASK,
  FIXTURE_OPEN_ASSIGNED,
  FIXTURE_OPEN_UNASSIGNED,
  FIXTURE_OPEN_YOURS,
  FIXTURE_RECURRING_INSTANCE,
  TEST_ENDED_MEMBERSHIP,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_MEMBERSHIP_A,
  TEST_MEMBERSHIP_B,
  TEST_REJOIN_MEMBERSHIP,
  notFoundBody,
} from './test-fixtures.js';
import { stubTasksApis } from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function assertNoInternalIds(container: HTMLElement = document.body) {
  const text = container.textContent ?? '';
  expect(text).not.toContain(FIXTURE_OPEN_ASSIGNED.id);
  expect(text).not.toContain(FIXTURE_OPEN_UNASSIGNED.id);
  expect(text).not.toContain(FIXTURE_COMPLETED.id);
  expect(text).not.toContain(TEST_MEMBERSHIP_A);
  expect(text).not.toContain(TEST_MEMBERSHIP_B);
  expect(text).not.toContain(TEST_ENDED_MEMBERSHIP);
  expect(text).not.toContain(TEST_REJOIN_MEMBERSHIP);
  expect(text).not.toContain(FIXTURE_DEFINITION_WEEKLY.id);
  expect(text).not.toContain(FIXTURE_DEFINITION_OTHER.creatorMembershipId);
}

describe('Tasks list page', () => {
  it('reaches Tasks from Home navigation and keeps the route Home-scoped', async () => {
    const user = userEvent.setup();
    stubTasksApis({
      listByHome: { [TEST_HOME_A]: [FIXTURE_OPEN_ASSIGNED] },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Tasks' }));

    expect(
      await screen.findByRole('heading', { name: 'Tasks', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/homes/${TEST_HOME_A}/tasks`);
    expect(await screen.findByText('Take out trash')).toBeInTheDocument();
  });

  it('renders current tasks, unassigned, You, repeating, and done', async () => {
    stubTasksApis({
      listByHome: {
        [TEST_HOME_A]: [
          FIXTURE_OPEN_ASSIGNED,
          FIXTURE_OPEN_UNASSIGNED,
          FIXTURE_OPEN_YOURS,
          FIXTURE_RECURRING_INSTANCE,
          FIXTURE_COMPLETED,
        ],
      },
      definitionsByHome: {
        [TEST_HOME_A]: [
          FIXTURE_DEFINITION_WEEKLY,
          FIXTURE_DEFINITION_DEACTIVATED,
        ],
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText('Take out trash')).toBeInTheDocument();
    expect(screen.getByText('Wipe counters')).toBeInTheDocument();
    expect(screen.getByText('Run dishwasher')).toBeInTheDocument();
    expect(screen.getByText('Sweep hallway')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Due / upcoming' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No due date' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Repeating' })).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
    expect(screen.getByText('Jamie')).toBeInTheDocument();
    expect(screen.getByText(FORMER_ROOMMATE_LABEL)).toBeInTheDocument();
    expect(screen.queryByText('Old repeating chore')).not.toBeInTheDocument();
    expect(screen.getAllByText('Repeats').length).toBeGreaterThan(0);
    assertNoInternalIds();
  });

  it('shows a useful empty state with Add task', async () => {
    stubTasksApis({
      listByHome: { [TEST_HOME_A]: [] },
      definitionsByHome: { [TEST_HOME_A]: [] },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(
      await screen.findByRole('heading', { name: 'No tasks yet', level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Add something the house needs to get done.'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'Add task' }).length,
    ).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/guilt|shame|overdue score/i);
  });

  it('excludes ended members from assignment display and picker', async () => {
    stubTasksApis({
      listByHome: { [TEST_HOME_A]: [FIXTURE_COMPLETED] },
      membershipsByHome: {
        [TEST_HOME_A]: {
          currentMembershipId: TEST_REJOIN_MEMBERSHIP,
          memberships: [
            { membershipId: TEST_REJOIN_MEMBERSHIP, name: 'Alex' },
            { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
          ],
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText('Sweep hallway')).toBeInTheDocument();
    expect(screen.getByText(FORMER_ROOMMATE_LABEL)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TEST_ENDED_MEMBERSHIP);

    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    const dialog = await screen.findByRole('dialog');
    const assignee = within(dialog).getByLabelText(/assigned to/i);
    const optionText = [...assignee.querySelectorAll('option')].map(
      (option) => option.textContent,
    );
    expect(optionText).toEqual(['Unassigned', 'You', 'Jamie']);
    expect(within(dialog).queryByText(TEST_ENDED_MEMBERSHIP)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(TEST_REJOIN_MEMBERSHIP)).not.toBeInTheDocument();
  });

  it('lets a Roommate complete and create; Admin does not get invented instance edits', async () => {
    stubTasksApis({
      homes: [
        {
          id: TEST_HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          hasPhoto: false,
          role: 'ROOMMATE',
        },
      ],
      listByHome: { [TEST_HOME_A]: [FIXTURE_OPEN_UNASSIGNED] },
      definitionsByHome: { [TEST_HOME_A]: [FIXTURE_DEFINITION_OTHER] },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText('Wipe counters')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark Wipe counters done' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add task' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Stop repeating' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete task/i })).not.toBeInTheDocument();
  });

  it('lets Home Admin stop repeating another roommate’s definition, not edit instances', async () => {
    stubTasksApis({
      listByHome: { [TEST_HOME_A]: [FIXTURE_OPEN_UNASSIGNED] },
      definitionsByHome: { [TEST_HOME_A]: [FIXTURE_DEFINITION_OTHER] },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText('Bathroom tidy')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Stop repeating' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete task/i })).not.toBeInTheDocument();
  });

  it('deactivates a repeating chore after confirmation', async () => {
    let definitions = [FIXTURE_DEFINITION_WEEKLY];
    stubTasksApis({
      listByHome: { [TEST_HOME_A]: [] },
      definitionsByHome: { [TEST_HOME_A]: () => definitions },
      deactivateByKey: {
        [`${TEST_HOME_A}:${FIXTURE_DEFINITION_WEEKLY.id}`]: (body) => {
          expect(body).toEqual({});
          const deactivated = {
            ...FIXTURE_DEFINITION_WEEKLY,
            deactivatedAt: '2026-09-24T12:00:00.000Z',
            nextOccurrenceDate: null,
          };
          definitions = [deactivated];
          return deactivated;
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText('Weekly trash')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop repeating' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Stop repeating' }),
    );
    await waitFor(() => {
      expect(screen.queryByText('Weekly trash')).not.toBeInTheDocument();
    });
  });

  it('lets the creator Roommate stop repeating their own definition', async () => {
    stubTasksApis({
      homes: [
        {
          id: TEST_HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          hasPhoto: false,
          role: 'ROOMMATE',
        },
      ],
      listByHome: { [TEST_HOME_A]: [] },
      definitionsByHome: { [TEST_HOME_A]: [FIXTURE_DEFINITION_WEEKLY] },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText('Weekly trash')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Stop repeating' }),
    ).toBeInTheDocument();
  });

  it('treats list-scope 404 as Home unavailable', async () => {
    stubTasksApis({
      listByHome: {
        [TEST_HOME_A]: { status: 404, body: notFoundBody() },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(
      await screen.findByRole('heading', {
        name: 'This Home isn’t available',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'No tasks yet' }),
    ).not.toBeInTheDocument();
  });

  it('shows retry UI for transient list errors without leaking backend codes', async () => {
    stubTasksApis({
      listByHome: {
        [TEST_HOME_A]: {
          status: 500,
          body: {
            error: {
              code: 'TASK_LIST_DENIED',
              message: 'SELECT * FROM task_instances',
            },
          },
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText(/Couldn’t load tasks/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/TASK_LIST_DENIED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SELECT \*/)).not.toBeInTheDocument();
  });

  it('does not render Home A tasks for Home B', async () => {
    stubTasksApis({
      listByHome: {
        [TEST_HOME_A]: [FIXTURE_OPEN_ASSIGNED],
        [TEST_HOME_B]: [FIXTURE_HOME_B_TASK],
      },
    });
    const { router, queryClient } = renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText('Take out trash')).toBeInTheDocument();
    expect(queryClient.getQueryData(taskKeys.list(TEST_HOME_A))).toBeDefined();

    await router.navigate(`/homes/${TEST_HOME_B}/tasks`);

    expect(await screen.findByText('Water the plants')).toBeInTheDocument();
    expect(screen.queryByText('Take out trash')).not.toBeInTheDocument();
    expect(taskKeys.list(TEST_HOME_B)[1]).toBe(TEST_HOME_B);
  });

  it('does not flash Home A tasks while Home B loads', async () => {
    stubTasksApis({
      listDelayMs: 60,
      delayedHomeId: TEST_HOME_B,
      listByHome: {
        [TEST_HOME_A]: [FIXTURE_OPEN_ASSIGNED],
        [TEST_HOME_B]: [FIXTURE_HOME_B_TASK],
      },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}/tasks`);

    expect(await screen.findByText('Take out trash')).toBeInTheDocument();
    await router.navigate(`/homes/${TEST_HOME_B}/tasks`);

    await waitFor(() => {
      expect(screen.queryByText('Take out trash')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Water the plants')).toBeInTheDocument();
    expect(screen.queryByText('Take out trash')).not.toBeInTheDocument();
  });

  it('clears Home-private Tasks through existing Home query clearing', async () => {
    stubTasksApis({
      listByHome: { [TEST_HOME_A]: [FIXTURE_OPEN_ASSIGNED] },
    });
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}/tasks`);
    expect(await screen.findByText('Take out trash')).toBeInTheDocument();
    expect(queryClient.getQueryData(taskKeys.list(TEST_HOME_A))).toBeDefined();

    clearPrivateHomeQueryState(queryClient);
    expect(queryClient.getQueryData(taskKeys.list(TEST_HOME_A))).toBeUndefined();
    expect(
      queryClient.getQueryData(taskKeys.definitions(TEST_HOME_A)),
    ).toBeUndefined();
  });
});
