import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { InvalidRequestError } from '../../platform/authz/errors.js';
import type { CreateManualTaskInput } from '../../application/tasks/create-manual-task.js';
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
  } = {},
) {
  const createCalls: CreateManualTaskInput[] = [];
  const listCalls: { actor: ActiveHomeActor; homeId: string }[] = [];
  return {
    createCalls,
    listCalls,
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
        },
      }),
    }),
  };
}

function taskPath(homeId: string = HOME_ID): string {
  return `/api/v1/homes/${homeId}/tasks`;
}

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  'taskDefinitionId',
  'completedAt',
  'userId',
  'SELECT',
  'stack',
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
