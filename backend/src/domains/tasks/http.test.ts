import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import type { CompleteTaskInput } from '../../application/tasks/complete-task.js';
import type { CreateManualTaskInput } from '../../application/tasks/create-manual-task.js';
import type { CreateRecurringTaskDefinitionInput } from '../../application/tasks/create-recurring-task-definition.js';
import type { DeactivateTaskDefinitionInput } from '../../application/tasks/deactivate-task-definition.js';
import {
  TaskAlreadyCompletedError,
  TaskDefinitionAlreadyDeactivatedError,
} from './errors.js';
import { parseHomeLocalDate } from './home-local-date.js';
import type { TaskDefinition } from './task-definition.js';
import {
  taskDefinitionDtoSchema,
  type TaskDefinitionDto,
} from './task-definition-dto.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { taskDtoSchema, type TaskDto } from './task-dto.js';
import type { TaskInstance } from './task.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const DEFINITION_ID = '018f1e2c-7e3a-7000-8000-1234567890ad';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const CREATED = new Date('2026-09-12T18:00:00.000Z');

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

function instance(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    id: TASK_ID,
    homeId: HOME_ID,
    source: 'MANUAL',
    status: 'OPEN',
    title: 'Take out trash',
    scheduledFor: null,
    assignedMembershipId: null,
    completedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function definition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: DEFINITION_ID,
    homeId: HOME_ID,
    title: 'Weekly trash',
    frequency: 'WEEKLY',
    weekday: 1,
    dayOfMonth: null,
    assignedMembershipId: null,
    creatorMembershipId: MEMBERSHIP_ID,
    nextOccurrenceDate: parseHomeLocalDate('2026-09-14'),
    nextOccurrenceAt: new Date('2026-09-14T00:00:00.000Z'),
    deactivatedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for tasks')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    createManualTask?: (input: CreateManualTaskInput) => Promise<TaskInstance>;
    listHomeTasks?: (input: {
      actor: ActiveHomeActor;
      homeId: string;
    }) => Promise<readonly TaskInstance[]>;
    completeTask?: (input: CompleteTaskInput) => Promise<TaskInstance>;
    createRecurringTaskDefinition?: (
      input: CreateRecurringTaskDefinitionInput,
    ) => Promise<TaskDefinition>;
    listHomeTaskDefinitions?: (input: {
      actor: ActiveHomeActor;
      homeId: string;
    }) => Promise<readonly TaskDefinition[]>;
    deactivateTaskDefinition?: (
      input: DeactivateTaskDefinitionInput,
    ) => Promise<TaskDefinition>;
  } = {},
) {
  const createCalls: CreateManualTaskInput[] = [];
  const listCalls: { actor: ActiveHomeActor; homeId: string }[] = [];
  const completeCalls: CompleteTaskInput[] = [];
  const createDefinitionCalls: CreateRecurringTaskDefinitionInput[] = [];
  const listDefinitionCalls: { actor: ActiveHomeActor; homeId: string }[] = [];
  const deactivateDefinitionCalls: DeactivateTaskDefinitionInput[] = [];
  return {
    createCalls,
    listCalls,
    completeCalls,
    createDefinitionCalls,
    listDefinitionCalls,
    deactivateDefinitionCalls,
    app: createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal:
            options.requirePrincipal ??
            (() => Promise.resolve({ userId: USER_ID })),
        },
        activeHomeActorResolver: {
          resolve:
            options.resolve ??
            (({ homeId }) => Promise.resolve({ ...actor(), homeId })),
        },
        homeReader: unusedHomeReader(),
        archiveFinalMemberHome: () =>
          Promise.reject(new Error('archive must not run for tasks')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for tasks')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for tasks')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for tasks')),
        tasks: {
          createManualTask: async (input) => {
            createCalls.push(input);
            if (options.createManualTask) {
              return options.createManualTask(input);
            }
            return instance({
              title: input.title,
              scheduledFor: input.scheduledFor ?? null,
              assignedMembershipId: input.assignedMembershipId ?? null,
            });
          },
          listHomeTasks: async (input) => {
            listCalls.push(input);
            if (options.listHomeTasks) {
              return options.listHomeTasks(input);
            }
            return [];
          },
          completeTask: async (input) => {
            completeCalls.push(input);
            if (options.completeTask) {
              return options.completeTask(input);
            }
            return instance({
              id: input.taskId,
              status: 'COMPLETED',
              completedAt: CREATED,
              updatedAt: CREATED,
            });
          },
          createRecurringTaskDefinition: async (input) => {
            createDefinitionCalls.push(input);
            if (options.createRecurringTaskDefinition) {
              return options.createRecurringTaskDefinition(input);
            }
            return definition({
              title: input.title,
              frequency: input.frequency,
              weekday: input.weekday ?? null,
              dayOfMonth: input.dayOfMonth ?? null,
              assignedMembershipId: input.assignedMembershipId ?? null,
            });
          },
          listHomeTaskDefinitions: async (input) => {
            listDefinitionCalls.push(input);
            if (options.listHomeTaskDefinitions) {
              return options.listHomeTaskDefinitions(input);
            }
            return [];
          },
          deactivateTaskDefinition: async (input) => {
            deactivateDefinitionCalls.push(input);
            if (options.deactivateTaskDefinition) {
              return options.deactivateTaskDefinition(input);
            }
            return definition({
              id: input.taskDefinitionId,
              deactivatedAt: CREATED,
              nextOccurrenceDate: null,
              nextOccurrenceAt: null,
              updatedAt: CREATED,
            });
          },
        },
      }),
    }),
  };
}

function taskPath(homeId: string = HOME_ID): string {
  return `/api/v1/homes/${homeId}/tasks`;
}

function completePath(
  homeId: string = HOME_ID,
  taskId: string = TASK_ID,
): string {
  return `/api/v1/homes/${homeId}/tasks/${taskId}/complete`;
}

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  'taskDefinitionId',
  'completedAt',
  'userId',
  'SELECT',
  'stack',
  'nextOccurrenceAt',
];

void describe('POST /api/v1/homes/:homeId/tasks', () => {
  void it('returns 201 with the exact safe DTO from a trusted Origin', async () => {
    const { app, createCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: taskPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: '  Take out trash  ' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = taskDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), [
      'id',
      'title',
      'status',
      'source',
      'scheduledFor',
      'assignedMembershipId',
      'createdAt',
      'updatedAt',
    ]);
    assert.equal(body.status, 'OPEN');
    assert.equal(body.source, 'MANUAL');
    assert.equal(body.title, 'Take out trash');
    assert.equal(body.scheduledFor, null);
    assert.equal('taskDefinitionId' in (res.json() as object), false);
    assert.equal('completedAt' in (res.json() as object), false);
    assert.equal('homeId' in (res.json() as object), false);
    assert.deepEqual(createCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        title: 'Take out trash',
        assignedMembershipId: null,
        scheduledFor: null,
      },
    ]);
  });

  void it('rejects a hostile Origin without invoking the command', async () => {
    const { app, createCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: taskPath(),
      headers: {
        Origin: HOSTILE_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Take out trash' }),
    });
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.deepEqual(createCalls, []);
    assert.equal(res.text.includes(HOSTILE_ORIGIN), false);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, createCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: taskPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Take out trash' }),
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(createCalls, []);
  });

  void it('rejects malformed bodies and unknown keys', async () => {
    const { app, createCalls } = buildApp();
    const invalidBodies = [
      null,
      [],
      'Take out trash',
      {},
      { title: 1 },
      { title: 'ok', source: 'RECURRING' },
      { title: 'ok', status: 'COMPLETED' },
      { title: 'ok', taskDefinitionId: TASK_ID },
      { title: 'ok', completedAt: CREATED.toISOString() },
      { title: 'ok', id: TASK_ID },
      { title: 'ok', homeId: HOME_ID },
      { title: '   ' },
      { title: 'ok', scheduledFor: '2026-02-30' },
      { title: 'ok', scheduledFor: '2026-09-15T00:00:00Z' },
    ];
    for (const body of invalidBodies) {
      const res = await appRequest(app, {
        method: 'POST',
        path: taskPath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(createCalls, []);
  });

  void it('conceals an inaccessible Home and maps a safe assignee rejection', async () => {
    const concealed = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const assignee = buildApp({
      createManualTask: () => Promise.reject(new InvalidRequestError()),
    });

    const hidden = await appRequest(concealed.app, {
      method: 'POST',
      path: taskPath(OTHER_HOME_ID),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Take out trash' }),
    });
    assert.equal(hidden.status, 404);
    assert.equal((hidden.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(concealed.createCalls, []);

    const rejected = await appRequest(assignee.app, {
      method: 'POST',
      path: taskPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Take out trash',
        assignedMembershipId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      (rejected.json() as ApiErrorBody).error.code,
      'INVALID_REQUEST',
    );
    assertNoForbiddenLeak({
      context: 'cross-home assignee HTTP',
      text: rejected.text,
      forbidden: leakSentinels,
    });
  });
});

void describe('GET /api/v1/homes/:homeId/tasks', () => {
  void it('returns the authorized safe list with private/no-store headers', async () => {
    const { app, listCalls } = buildApp({
      listHomeTasks: () =>
        Promise.resolve([
          instance({
            scheduledFor: '2026-09-15',
            title: 'Dated',
          }),
          instance({
            id: '018f1e2c-7e3a-7000-8000-1234567890ac',
            title: 'Undated',
          }),
        ]),
    });
    const res = await appRequest(app, { path: taskPath() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = res.json() as TaskDto[];
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length, 2);
    assert.deepEqual(Object.keys(body[0] ?? {}), [
      'id',
      'title',
      'status',
      'source',
      'scheduledFor',
      'assignedMembershipId',
      'createdAt',
      'updatedAt',
    ]);
    assert.equal('taskDefinitionId' in (body[0] ?? {}), false);
    assert.deepEqual(listCalls[0]?.homeId, HOME_ID);
  });

  void it('returns 401 for unauthenticated list requests', async () => {
    const { app, listCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, { path: taskPath() });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(listCalls, []);
  });

  void it('conceals an inaccessible Home consistently', async () => {
    const { app, listCalls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, { path: taskPath(OTHER_HOME_ID) });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(listCalls, []);
    assertNoForbiddenLeak({
      context: 'concealed task list',
      text: res.text,
      forbidden: leakSentinels,
    });
  });
});

void describe('POST /api/v1/homes/:homeId/tasks/:taskId/complete', () => {
  void it('returns 200 with the exact safe DTO from a trusted Origin', async () => {
    const { app, completeCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: completePath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = taskDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), [
      'id',
      'title',
      'status',
      'source',
      'scheduledFor',
      'assignedMembershipId',
      'createdAt',
      'updatedAt',
    ]);
    assert.equal(body.status, 'COMPLETED');
    assert.equal(body.id, TASK_ID);
    assert.equal('completedAt' in (res.json() as object), false);
    assert.equal('taskDefinitionId' in (res.json() as object), false);
    assert.equal('homeId' in (res.json() as object), false);
    assert.deepEqual(completeCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        taskId: TASK_ID,
      },
    ]);
  });

  void it('accepts an empty JSON object body', async () => {
    const { app, completeCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: completePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal(completeCalls.length, 1);
  });

  void it('rejects client-supplied completion fields', async () => {
    const { app, completeCalls } = buildApp();
    const invalidBodies = [
      { completedAt: CREATED.toISOString() },
      { status: 'COMPLETED' },
      { userId: USER_ID },
      { membershipId: MEMBERSHIP_ID },
      { source: 'MANUAL' },
      { title: 'changed' },
      [],
    ];
    for (const body of invalidBodies) {
      const res = await appRequest(app, {
        method: 'POST',
        path: completePath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(completeCalls, []);
  });

  void it('rejects a hostile Origin without invoking the command', async () => {
    const { app, completeCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: completePath(),
      headers: { Origin: HOSTILE_ORIGIN },
    });
    assert.equal(res.status, 403);
    assert.equal((res.json() as ApiErrorBody).error.code, 'FORBIDDEN');
    assert.deepEqual(completeCalls, []);
    assert.equal(res.text.includes(HOSTILE_ORIGIN), false);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, completeCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: completePath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(completeCalls, []);
  });

  void it('conceals an inaccessible Home, unknown Task, and ended actor', async () => {
    const hiddenHome = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const unknownTask = buildApp({
      completeTask: () => Promise.reject(new ConcealedNotFoundError()),
    });

    const hidden = await appRequest(hiddenHome.app, {
      method: 'POST',
      path: completePath(OTHER_HOME_ID),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(hidden.status, 404);
    assert.equal((hidden.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(hiddenHome.completeCalls, []);

    const missing = await appRequest(unknownTask.app, {
      method: 'POST',
      path: completePath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assertNoForbiddenLeak({
      context: 'unknown task complete HTTP',
      text: missing.text,
      forbidden: leakSentinels,
    });
  });

  void it('maps already-completed to 409 TASK_ALREADY_COMPLETED', async () => {
    const { app } = buildApp({
      completeTask: () => Promise.reject(new TaskAlreadyCompletedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: completePath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 409);
    assert.equal(
      (res.json() as ApiErrorBody).error.code,
      'TASK_ALREADY_COMPLETED',
    );
    assertNoForbiddenLeak({
      context: 'already completed HTTP',
      text: res.text,
      forbidden: leakSentinels,
    });
  });
});

function definitionPath(homeId: string = HOME_ID): string {
  return `/api/v1/homes/${homeId}/task-definitions`;
}

function deactivatePath(
  homeId: string = HOME_ID,
  taskDefinitionId: string = DEFINITION_ID,
): string {
  return `/api/v1/homes/${homeId}/task-definitions/${taskDefinitionId}/deactivate`;
}

const definitionDtoKeys = [
  'id',
  'title',
  'frequency',
  'weekday',
  'dayOfMonth',
  'assignedMembershipId',
  'creatorMembershipId',
  'nextOccurrenceDate',
  'deactivatedAt',
  'createdAt',
  'updatedAt',
];

void describe('POST /api/v1/homes/:homeId/task-definitions', () => {
  void it('returns 201 with the exact safe DTO from a trusted Origin', async () => {
    const { app, createDefinitionCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: definitionPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: '  Weekly trash  ',
        frequency: 'WEEKLY',
        weekday: 1,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = taskDefinitionDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), definitionDtoKeys);
    assert.equal(body.title, 'Weekly trash');
    assert.equal(body.frequency, 'WEEKLY');
    assert.equal(body.weekday, 1);
    assert.equal(body.dayOfMonth, null);
    assert.equal('nextOccurrenceAt' in (res.json() as object), false);
    assert.equal('homeId' in (res.json() as object), false);
    assert.deepEqual(createDefinitionCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        title: 'Weekly trash',
        frequency: 'WEEKLY',
        weekday: 1,
        dayOfMonth: null,
        assignedMembershipId: null,
      },
    ]);
  });

  void it('rejects hostile Origin, unauthenticated requests, and extra fields', async () => {
    const hostile = buildApp();
    const blocked = await appRequest(hostile.app, {
      method: 'POST',
      path: definitionPath(),
      headers: {
        Origin: HOSTILE_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Weekly trash', frequency: 'DAILY' }),
    });
    assert.equal(blocked.status, 403);
    assert.deepEqual(hostile.createDefinitionCalls, []);

    const unauth = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const denied = await appRequest(unauth.app, {
      method: 'POST',
      path: definitionPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Weekly trash', frequency: 'DAILY' }),
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(unauth.createDefinitionCalls, []);

    const invalidBodies = [
      { title: 'ok', frequency: 'DAILY', weekday: 1 },
      { title: 'ok', frequency: 'DAILY', dayOfMonth: 15 },
      { title: 'ok', frequency: 'WEEKLY' },
      { title: 'ok', frequency: 'WEEKLY', weekday: 1, dayOfMonth: 15 },
      { title: 'ok', frequency: 'WEEKLY', weekday: 0 },
      { title: 'ok', frequency: 'WEEKLY', weekday: 8 },
      { title: 'ok', frequency: 'WEEKLY', weekday: 1.5 },
      { title: 'ok', frequency: 'MONTHLY' },
      { title: 'ok', frequency: 'MONTHLY', weekday: 1, dayOfMonth: 15 },
      { title: 'ok', frequency: 'MONTHLY', dayOfMonth: 0 },
      { title: 'ok', frequency: 'MONTHLY', dayOfMonth: 32 },
      { title: 'ok', frequency: 'MONTHLY', dayOfMonth: 15.2 },
      { title: '   ', frequency: 'DAILY' },
      { title: 'ok', frequency: 'DAILY', creatorMembershipId: MEMBERSHIP_ID },
      { title: 'ok', frequency: 'DAILY', nextOccurrenceDate: '2026-09-13' },
      {
        title: 'ok',
        frequency: 'DAILY',
        nextOccurrenceAt: CREATED.toISOString(),
      },
      { title: 'ok', frequency: 'DAILY', deactivatedAt: null },
      { title: 'ok', frequency: 'DAILY', homeId: HOME_ID },
      { title: 'ok', frequency: 'DAILY', source: 'RECURRING' },
      { title: 'ok', frequency: 'DAILY', status: 'ACTIVE' },
    ];
    const { app, createDefinitionCalls } = buildApp();
    for (const body of invalidBodies) {
      const res = await appRequest(app, {
        method: 'POST',
        path: definitionPath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(createDefinitionCalls, []);
  });
});

void describe('GET /api/v1/homes/:homeId/task-definitions', () => {
  void it('returns the authorized safe list with private/no-store headers', async () => {
    const { app, listDefinitionCalls } = buildApp({
      listHomeTaskDefinitions: () =>
        Promise.resolve([
          definition({ title: 'Active' }),
          definition({
            id: '018f1e2c-7e3a-7000-8000-1234567890ae',
            title: 'Old',
            deactivatedAt: CREATED,
            nextOccurrenceDate: null,
            nextOccurrenceAt: null,
          }),
        ]),
    });
    const res = await appRequest(app, { path: definitionPath() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = res.json() as TaskDefinitionDto[];
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length, 2);
    assert.deepEqual(Object.keys(body[0] ?? {}), definitionDtoKeys);
    assert.equal('nextOccurrenceAt' in (body[0] ?? {}), false);
    assert.equal(body[0]?.nextOccurrenceDate, '2026-09-14');
    assert.deepEqual(listDefinitionCalls[0]?.homeId, HOME_ID);
  });

  void it('returns 401 and conceals inaccessible Homes', async () => {
    const unauth = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const denied = await appRequest(unauth.app, { path: definitionPath() });
    assert.equal(denied.status, 401);
    assert.deepEqual(unauth.listDefinitionCalls, []);

    const hidden = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const concealed = await appRequest(hidden.app, {
      path: definitionPath(OTHER_HOME_ID),
    });
    assert.equal(concealed.status, 404);
    assert.deepEqual(hidden.listDefinitionCalls, []);
  });
});

void describe('POST /api/v1/homes/:homeId/task-definitions/:taskDefinitionId/deactivate', () => {
  void it('returns 200 with the exact safe DTO from a trusted Origin', async () => {
    const { app, deactivateDefinitionCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: deactivatePath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = taskDefinitionDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), definitionDtoKeys);
    assert.equal(body.deactivatedAt, CREATED.toISOString());
    assert.equal(body.nextOccurrenceDate, null);
    assert.equal('nextOccurrenceAt' in (res.json() as object), false);
    assert.deepEqual(deactivateDefinitionCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        taskDefinitionId: DEFINITION_ID,
      },
    ]);
  });

  void it('rejects mutation fields and maps already-deactivated to 409', async () => {
    const invalid = buildApp();
    const rejected = await appRequest(invalid.app, {
      method: 'POST',
      path: deactivatePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ deactivatedAt: CREATED.toISOString() }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(invalid.deactivateDefinitionCalls, []);

    const { app } = buildApp({
      deactivateTaskDefinition: () =>
        Promise.reject(new TaskDefinitionAlreadyDeactivatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: deactivatePath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 409);
    assert.equal(
      (res.json() as ApiErrorBody).error.code,
      'TASK_DEFINITION_ALREADY_DEACTIVATED',
    );
  });
});
