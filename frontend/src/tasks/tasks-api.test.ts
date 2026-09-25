import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiClient, resetApiClientForTests } from '../platform/api/index.js';
import {
  completeHomeTask,
  createHomeTask,
  createHomeTaskDefinition,
  deactivateHomeTaskDefinition,
  listHomeTaskDefinitions,
  listHomeTasks,
} from './tasks-api.js';
import {
  FIXTURE_DEFINITION_WEEKLY,
  FIXTURE_OPEN_ASSIGNED,
  TEST_HOME_A,
  TEST_MEMBERSHIP_B,
} from './test-fixtures.js';
import { stubTasksApis } from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('tasks API', () => {
  it('GETs Home-scoped tasks with credentials', async () => {
    const fetchMock = stubTasksApis({
      listByHome: { [TEST_HOME_A]: [FIXTURE_OPEN_ASSIGNED] },
    });
    getApiClient();
    const result = await listHomeTasks(TEST_HOME_A);
    expect(result).toEqual([FIXTURE_OPEN_ASSIGNED]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(new URL(url).pathname).toBe(`/api/v1/homes/${TEST_HOME_A}/tasks`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).credentials).toBe(
      'include',
    );
  });

  it('POSTs a one-time task and rejects extra DTO fields', async () => {
    const fetchMock = stubTasksApis({
      createByHome: {
        [TEST_HOME_A]: FIXTURE_OPEN_ASSIGNED,
      },
    });
    getApiClient();
    const created = await createHomeTask(TEST_HOME_A, {
      title: 'Take out trash',
      assignedMembershipId: TEST_MEMBERSHIP_B,
      scheduledFor: '2026-09-25',
    });
    expect(created.title).toBe('Take out trash');
    const init = fetchMock.mock.calls.find((call) => {
      const requestInit = call[1] as RequestInit | undefined;
      return (requestInit?.method ?? 'GET').toUpperCase() === 'POST';
    })?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Take out trash',
      assignedMembershipId: TEST_MEMBERSHIP_B,
      scheduledFor: '2026-09-25',
    });
  });

  it('POSTs complete with {}', async () => {
    const fetchMock = stubTasksApis({
      completeByKey: {
        [`${TEST_HOME_A}:${FIXTURE_OPEN_ASSIGNED.id}`]: {
          ...FIXTURE_OPEN_ASSIGNED,
          status: 'COMPLETED',
        },
      },
    });
    getApiClient();
    const completed = await completeHomeTask(
      TEST_HOME_A,
      FIXTURE_OPEN_ASSIGNED.id,
    );
    expect(completed.status).toBe('COMPLETED');
    const completeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/complete'),
    );
    expect(JSON.parse(String((completeCall?.[1] as RequestInit).body))).toEqual(
      {},
    );
  });

  it('lists and creates recurring definitions', async () => {
    stubTasksApis({
      definitionsByHome: { [TEST_HOME_A]: [FIXTURE_DEFINITION_WEEKLY] },
      createDefinitionByHome: { [TEST_HOME_A]: FIXTURE_DEFINITION_WEEKLY },
    });
    getApiClient();
    const listed = await listHomeTaskDefinitions(TEST_HOME_A);
    expect(listed).toEqual([FIXTURE_DEFINITION_WEEKLY]);
    const created = await createHomeTaskDefinition(TEST_HOME_A, {
      title: 'Weekly trash',
      frequency: 'WEEKLY',
      weekday: 1,
      assignedMembershipId: null,
    });
    expect(created.frequency).toBe('WEEKLY');
  });

  it('deactivates a definition with {}', async () => {
    const fetchMock = stubTasksApis({
      deactivateByKey: {
        [`${TEST_HOME_A}:${FIXTURE_DEFINITION_WEEKLY.id}`]: {
          ...FIXTURE_DEFINITION_WEEKLY,
          deactivatedAt: '2026-09-24T12:00:00.000Z',
          nextOccurrenceDate: null,
        },
      },
    });
    getApiClient();
    const deactivated = await deactivateHomeTaskDefinition(
      TEST_HOME_A,
      FIXTURE_DEFINITION_WEEKLY.id,
    );
    expect(deactivated.deactivatedAt).not.toBeNull();
    const call = fetchMock.mock.calls.find((entry) =>
      String(entry[0]).includes('/deactivate'),
    );
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({});
  });
});
