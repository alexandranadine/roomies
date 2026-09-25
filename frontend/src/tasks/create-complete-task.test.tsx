import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityKeys } from '../activity/activity-query-keys.js';
import { resetApiClientForTests } from '../platform/api/index.js';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { renderApp } from '../test/render.js';
import { taskKeys } from './tasks-query-keys.js';
import {
  FIXTURE_DEFINITION_DAILY,
  FIXTURE_DEFINITION_MONTHLY,
  FIXTURE_DEFINITION_WEEKLY,
  FIXTURE_HOME_B_TASK,
  FIXTURE_OPEN_ASSIGNED,
  FIXTURE_OPEN_UNASSIGNED,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_MEMBERSHIP_B,
} from './test-fixtures.js';
import { stubTasksApis, taskCacheKey } from './test-stub.js';

const CREATED_ID = 'c1111111-1111-4111-8111-111111111111';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openCreateDialog() {
  const buttons = await screen.findAllByRole('button', { name: 'Add task' });
  await userEvent.click(buttons[0]!);
  const dialog = await screen.findByRole('dialog');
  expect(
    await within(dialog).findByRole('textbox', { name: /title/i }),
  ).toBeInTheDocument();
  await within(dialog).findByRole('option', { name: 'Jamie' });
  return dialog;
}

function lastCreateBody(fetchMock: ReturnType<typeof stubTasksApis>) {
  const createCalls = fetchMock.mock.calls.filter((call) => {
    const url = String(call[0]);
    const init = call[1] as RequestInit | undefined;
    return (
      url.endsWith(`/homes/${TEST_HOME_A}/tasks`) &&
      (init?.method ?? 'GET').toUpperCase() === 'POST'
    );
  });
  const last = createCalls[createCalls.length - 1];
  expect(last).toBeDefined();
  return JSON.parse(String((last?.[1] as RequestInit).body)) as Record<
    string,
    unknown
  >;
}

describe('Tasks create UI', () => {
  it('creates a valid assigned one-time task', async () => {
    let tasks: Array<{
      id: string;
      title: string;
      status: 'OPEN' | 'COMPLETED';
      source: 'MANUAL' | 'RECURRING';
      scheduledFor: string | null;
      assignedMembershipId: string | null;
      createdAt: string;
      updatedAt: string;
    }> = [];
    const fetchMock = stubTasksApis({
      listByHome: { [TEST_HOME_A]: () => tasks },
      createByHome: {
        [TEST_HOME_A]: (body) => {
          const payload = body as {
            title: string;
            assignedMembershipId: string | null;
            scheduledFor: string | null;
          };
          const created = {
            id: CREATED_ID,
            title: payload.title,
            status: 'OPEN' as const,
            source: 'MANUAL' as const,
            scheduledFor: payload.scheduledFor,
            assignedMembershipId: payload.assignedMembershipId,
            createdAt: '2026-09-24T12:00:00.000Z',
            updatedAt: '2026-09-24T12:00:00.000Z',
          };
          tasks = [created, ...tasks];
          return created;
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);
    const dialog = await openCreateDialog();

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Buy paper towels',
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/assigned to/i),
      TEST_MEMBERSHIP_B,
    );
    const due = within(dialog).getByLabelText(/due date/i);
    fireEvent.change(due, { target: { value: '2026-09-30' } });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add task' }),
    );

    await waitFor(() => {
      expect(lastCreateBody(fetchMock)).toEqual({
        title: 'Buy paper towels',
        assignedMembershipId: TEST_MEMBERSHIP_B,
        scheduledFor: '2026-09-30',
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Buy paper towels')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(CREATED_ID);
    expect(document.body.textContent).not.toContain(TEST_MEMBERSHIP_B);
  });

  it('disables duplicate submit while create is pending', async () => {
    const fetchMock = stubTasksApis({
      listByHome: { [TEST_HOME_A]: [] },
      createDelayMs: 80,
      createByHome: {
        [TEST_HOME_A]: {
          id: CREATED_ID,
          title: 'Slow task',
          status: 'OPEN',
          source: 'MANUAL',
          scheduledFor: null,
          assignedMembershipId: null,
          createdAt: '2026-09-24T12:00:00.000Z',
          updatedAt: '2026-09-24T12:00:00.000Z',
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);
    const dialog = await openCreateDialog();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Slow task',
    );
    const submit = within(dialog).getByRole('button', { name: 'Add task' });
    await userEvent.click(submit);
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const createCalls = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return (
        url.endsWith(`/homes/${TEST_HOME_A}/tasks`) &&
        (init?.method ?? 'GET').toUpperCase() === 'POST'
      );
    });
    expect(createCalls).toHaveLength(1);
  });

  it('keeps the form recoverable after create failure', async () => {
    stubTasksApis({
      listByHome: { [TEST_HOME_A]: [] },
      createByHome: {
        [TEST_HOME_A]: {
          status: 400,
          body: {
            error: { code: 'INVALID_REQUEST', message: 'bad SQL' },
          },
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);
    const dialog = await openCreateDialog();
    const title = within(dialog).getByRole('textbox', { name: /title/i });
    await userEvent.type(title, 'Keep me');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add task' }),
    );
    expect(
      await screen.findByText(/Couldn’t add this task/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(title).toHaveValue('Keep me');
    expect(screen.queryByText(/INVALID_REQUEST/)).not.toBeInTheDocument();
    expect(screen.queryByText(/bad SQL/)).not.toBeInTheDocument();
  });

  it('creates a weekly repeating chore through TaskDefinitions', async () => {
    const fetchMock = stubTasksApis({
      listByHome: { [TEST_HOME_A]: [] },
      createDefinitionByHome: {
        [TEST_HOME_A]: FIXTURE_DEFINITION_WEEKLY,
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);
    const dialog = await openCreateDialog();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Weekly trash',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Every week' }));
    await within(dialog).findByLabelText(/weekday/i);
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/weekday/i),
      '1',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add task' }),
    );

    await waitFor(() => {
      const createCalls = fetchMock.mock.calls.filter((call) => {
        const url = String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url.includes('/task-definitions') &&
          (init?.method ?? 'GET').toUpperCase() === 'POST'
        );
      });
      const last = createCalls[createCalls.length - 1];
      expect(last).toBeDefined();
      expect(JSON.parse(String((last?.[1] as RequestInit).body))).toEqual({
        title: 'Weekly trash',
        frequency: 'WEEKLY',
        weekday: 1,
        assignedMembershipId: null,
      });
    });
  });

  it('creates a daily repeating chore through TaskDefinitions', async () => {
    const fetchMock = stubTasksApis({
      listByHome: { [TEST_HOME_A]: [] },
      createDefinitionByHome: {
        [TEST_HOME_A]: FIXTURE_DEFINITION_DAILY,
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);
    const dialog = await openCreateDialog();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Wipe stove',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Every day' }));
    expect(within(dialog).queryByLabelText(/weekday/i)).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(/day of month/i),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add task' }),
    );

    await waitFor(() => {
      const createCalls = fetchMock.mock.calls.filter((call) => {
        const url = String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url.includes('/task-definitions') &&
          (init?.method ?? 'GET').toUpperCase() === 'POST'
        );
      });
      const last = createCalls[createCalls.length - 1];
      expect(last).toBeDefined();
      expect(JSON.parse(String((last?.[1] as RequestInit).body))).toEqual({
        title: 'Wipe stove',
        frequency: 'DAILY',
        assignedMembershipId: null,
      });
    });
  });

  it('creates a monthly repeating chore through TaskDefinitions', async () => {
    const fetchMock = stubTasksApis({
      listByHome: { [TEST_HOME_A]: [] },
      createDefinitionByHome: {
        [TEST_HOME_A]: FIXTURE_DEFINITION_MONTHLY,
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);
    const dialog = await openCreateDialog();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Clean kitchen',
    );
    await userEvent.click(
      within(dialog).getByRole('radio', { name: 'Every month' }),
    );
    await within(dialog).findByLabelText(/day of month/i);
    expect(within(dialog).queryByLabelText(/weekday/i)).not.toBeInTheDocument();
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/day of month/i),
      '1',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add task' }),
    );

    await waitFor(() => {
      const createCalls = fetchMock.mock.calls.filter((call) => {
        const url = String(call[0]);
        const init = call[1] as RequestInit | undefined;
        return (
          url.includes('/task-definitions') &&
          (init?.method ?? 'GET').toUpperCase() === 'POST'
        );
      });
      const last = createCalls[createCalls.length - 1];
      expect(last).toBeDefined();
      expect(JSON.parse(String((last?.[1] as RequestInit).body))).toEqual({
        title: 'Clean kitchen',
        frequency: 'MONTHLY',
        dayOfMonth: 1,
        assignedMembershipId: null,
      });
    });
  });

  it('invalidates same-Home Pulse only after create', async () => {
    stubTasksApis({
      listByHome: {
        [TEST_HOME_A]: [],
        [TEST_HOME_B]: [FIXTURE_HOME_B_TASK],
      },
      createByHome: {
        [TEST_HOME_A]: {
          ...FIXTURE_OPEN_UNASSIGNED,
          id: CREATED_ID,
          title: 'Created',
        },
      },
    });
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}/tasks`);
    await queryClient.fetchQuery({
      queryKey: taskKeys.list(TEST_HOME_B),
      queryFn: () => Promise.resolve([FIXTURE_HOME_B_TASK]),
    });
    queryClient.setQueryData(pulseKeys.all(TEST_HOME_A), clearHousePulse());
    queryClient.setQueryData(pulseKeys.all(TEST_HOME_B), clearHousePulse());
    const otherBefore = queryClient.getQueryState(taskKeys.list(TEST_HOME_B))
      ?.dataUpdatedAt;
    const otherPulseBefore = queryClient.getQueryState(pulseKeys.all(TEST_HOME_B))
      ?.dataUpdatedAt;

    const dialog = await openCreateDialog();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /title/i }),
      'Created',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Add task' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryState(pulseKeys.all(TEST_HOME_A))?.isInvalidated,
      ).toBe(true);
    });
    expect(
      queryClient.getQueryState(taskKeys.list(TEST_HOME_B))?.dataUpdatedAt,
    ).toBe(otherBefore);
    expect(
      queryClient.getQueryState(pulseKeys.all(TEST_HOME_B))?.dataUpdatedAt,
    ).toBe(otherPulseBefore);
  });
});

describe('Tasks completion UI', () => {
  it('completes from the row, keeps the task incomplete on failure, and updates on success', async () => {
    let shouldFail = true;
    let tasks = [FIXTURE_OPEN_UNASSIGNED];
    const fetchMock = stubTasksApis({
      listByHome: { [TEST_HOME_A]: () => tasks },
      completeByKey: {
        [taskCacheKey(TEST_HOME_A, FIXTURE_OPEN_UNASSIGNED.id)]: (body) => {
          expect(body).toEqual({});
          if (shouldFail) {
            shouldFail = false;
            return {
              status: 500,
              body: {
                error: { code: 'INTERNAL', message: 'SELECT boom' },
              },
            };
          }
          const completed = {
            ...FIXTURE_OPEN_UNASSIGNED,
            status: 'COMPLETED' as const,
          };
          tasks = [completed];
          return completed;
        },
      },
      completeDelayMs: 40,
    });
    const { queryClient } = renderApp(`/homes/${TEST_HOME_A}/tasks`);
    queryClient.setQueryData(pulseKeys.all(TEST_HOME_A), clearHousePulse());
    queryClient.setQueryData(activityKeys.list(TEST_HOME_A), {
      pages: [],
      pageParams: [],
    });

    const button = await screen.findByRole('button', {
      name: 'Mark Wipe counters done',
    });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(
      await screen.findByText(/Couldn’t mark this done/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SELECT boom/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark Wipe counters done' }),
    ).toBeInTheDocument();
    expect(
      (queryClient.getQueryData(taskKeys.list(TEST_HOME_A)) as typeof FIXTURE_OPEN_UNASSIGNED[])[0]
        ?.status,
    ).toBe('OPEN');

    await userEvent.click(
      screen.getByRole('button', { name: 'Mark Wipe counters done' }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Mark Wipe counters done' }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Completed 1' })).toBeInTheDocument();
    expect(screen.getByText('Wipe counters')).toBeInTheDocument();
    const completeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes(
        `/homes/${TEST_HOME_A}/tasks/${FIXTURE_OPEN_UNASSIGNED.id}/complete`,
      ),
    );
    expect(completeCall).toBeDefined();
    await waitFor(() => {
      expect(
        queryClient.getQueryState(pulseKeys.all(TEST_HOME_A))?.isInvalidated,
      ).toBe(true);
      expect(
        queryClient.getQueryState(activityKeys.list(TEST_HOME_A))
          ?.isInvalidated,
      ).toBe(true);
    });
  });

  it('does not complete a task from another Home', async () => {
    stubTasksApis({
      listByHome: {
        [TEST_HOME_A]: [FIXTURE_OPEN_ASSIGNED],
        [TEST_HOME_B]: [FIXTURE_HOME_B_TASK],
      },
      completeByKey: {
        [taskCacheKey(TEST_HOME_B, FIXTURE_HOME_B_TASK.id)]: {
          ...FIXTURE_HOME_B_TASK,
          status: 'COMPLETED',
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/tasks`);
    expect(await screen.findByText('Take out trash')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark Take out trash done' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Water the plants')).not.toBeInTheDocument();
  });
});
