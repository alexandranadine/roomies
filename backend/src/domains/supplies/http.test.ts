import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CreateSupplyEntryInput } from '../../application/supplies/create-supply-entry.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import { SUPPLY_TITLE_MAX_LENGTH } from './supply-title.js';
import {
  supplyEntryDtoSchema,
  type SupplyEntryDto,
} from './supply-entry-dto.js';
import type { SupplyEntry } from './supply.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
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

function entry(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: ENTRY_ID,
    homeId: HOME_ID,
    title: 'Paper towels',
    status: 'OPEN',
    createdByMembershipId: MEMBERSHIP_ID,
    obtainedAt: null,
    canceledAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function unusedHomeReader() {
  return {
    findActiveHomeById: () =>
      Promise.reject(new Error('home reader must not run for supplies')),
  };
}

function buildApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    createSupplyEntry?: (input: CreateSupplyEntryInput) => Promise<SupplyEntry>;
    listHomeSupplies?: (input: {
      actor: ActiveHomeActor;
      homeId: string;
      status?: SupplyEntry['status'];
    }) => Promise<readonly SupplyEntry[]>;
  } = {},
) {
  const createCalls: CreateSupplyEntryInput[] = [];
  const listCalls: {
    actor: ActiveHomeActor;
    homeId: string;
    status?: SupplyEntry['status'];
  }[] = [];
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
          Promise.reject(new Error('archive must not run for supplies')),
        changeMembershipRole: () =>
          Promise.reject(new Error('role change must not run for supplies')),
        leaveMembership: () =>
          Promise.reject(new Error('leave must not run for supplies')),
        removeMembership: () =>
          Promise.reject(new Error('remove must not run for supplies')),
        supplies: {
          createSupplyEntry: async (input) => {
            createCalls.push(input);
            if (options.createSupplyEntry) {
              return options.createSupplyEntry(input);
            }
            return entry({ title: input.title });
          },
          listHomeSupplies: async (input) => {
            listCalls.push(input);
            if (options.listHomeSupplies) {
              return options.listHomeSupplies(input);
            }
            return [];
          },
        },
      }),
    }),
  };
}

function supplyPath(homeId: string = HOME_ID): string {
  return `/api/v1/homes/${homeId}/supplies`;
}

const dtoKeys = [
  'id',
  'title',
  'status',
  'createdByMembershipId',
  'obtainedAt',
  'canceledAt',
  'createdAt',
  'updatedAt',
];

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  'activeClaim',
  'claimedBy',
  'canClaim',
  'claimant',
  'userId',
  'SELECT',
  'stack',
];

void describe('POST /api/v1/homes/:homeId/supplies', () => {
  void it('returns 201 with the exact safe DTO from a trusted Origin', async () => {
    const { app, createCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: supplyPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: '  Paper towels  ' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = supplyEntryDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), dtoKeys);
    assert.equal(body.status, 'OPEN');
    assert.equal(body.title, 'Paper towels');
    assert.equal(body.createdByMembershipId, MEMBERSHIP_ID);
    assert.equal(body.obtainedAt, null);
    assert.equal(body.canceledAt, null);
    assert.equal('homeId' in (res.json() as object), false);
    assert.equal('activeClaim' in (res.json() as object), false);
    assert.equal('claimedBy' in (res.json() as object), false);
    assert.equal('canClaim' in (res.json() as object), false);
    assert.deepEqual(createCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        title: 'Paper towels',
      },
    ]);
  });

  void it('rejects a hostile Origin without invoking the command', async () => {
    const { app, createCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: supplyPath(),
      headers: {
        Origin: HOSTILE_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Paper towels' }),
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
      path: supplyPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Paper towels' }),
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(createCalls, []);
  });

  void it('rejects malformed bodies, unknown keys, and injections', async () => {
    const { app, createCalls } = buildApp();
    const invalidBodies = [
      null,
      [],
      'Paper towels',
      {},
      { title: 1 },
      { title: 'ok', status: 'OBTAINED' },
      { title: 'ok', createdByMembershipId: MEMBERSHIP_ID },
      { title: 'ok', obtainedAt: CREATED.toISOString() },
      { title: 'ok', canceledAt: CREATED.toISOString() },
      { title: 'ok', homeId: HOME_ID },
      { title: 'ok', id: ENTRY_ID },
      { title: 'ok', createdAt: CREATED.toISOString() },
      { title: 'ok', updatedAt: CREATED.toISOString() },
      { title: '   ' },
      { title: 'x'.repeat(SUPPLY_TITLE_MAX_LENGTH + 1) },
    ];
    for (const body of invalidBodies) {
      const res = await appRequest(app, {
        method: 'POST',
        path: supplyPath(),
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

  void it('conceals an inaccessible Home', async () => {
    const { app, createCalls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: supplyPath(OTHER_HOME_ID),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Paper towels' }),
    });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(createCalls, []);
    assertNoForbiddenLeak({
      context: 'concealed supply create HTTP',
      text: res.text,
      forbidden: leakSentinels,
    });
  });
});

void describe('GET /api/v1/homes/:homeId/supplies', () => {
  void it('returns the authorized safe list with private/no-store headers', async () => {
    const { app, listCalls } = buildApp({
      listHomeSupplies: () =>
        Promise.resolve([
          entry({ title: 'Open first' }),
          entry({
            id: '018f1e2c-7e3a-7000-8000-1234567890ac',
            title: 'Terminal',
            status: 'CANCELED',
            canceledAt: CREATED,
          }),
        ]),
    });
    const res = await appRequest(app, { path: supplyPath() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = res.json() as SupplyEntryDto[];
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length, 2);
    assert.deepEqual(Object.keys(body[0] ?? {}), dtoKeys);
    assert.equal('homeId' in (body[0] ?? {}), false);
    assert.equal('activeClaim' in (body[0] ?? {}), false);
    assert.equal('claimedBy' in (body[0] ?? {}), false);
    assert.equal('canClaim' in (body[0] ?? {}), false);
    assert.deepEqual(listCalls[0]?.homeId, HOME_ID);
    assert.equal(listCalls[0]?.status, undefined);
  });

  void it('does not require a mutation Origin', async () => {
    const { app, listCalls } = buildApp({
      listHomeSupplies: () => Promise.resolve([]),
    });
    const missing = await appRequest(app, { path: supplyPath() });
    assert.equal(missing.status, 200);
    const hostile = await appRequest(app, {
      path: supplyPath(),
      headers: { Origin: HOSTILE_ORIGIN },
    });
    assert.equal(hostile.status, 200);
    assert.equal(listCalls.length, 2);
  });

  void it('passes a valid status filter and rejects invalid status', async () => {
    const valid = buildApp();
    const open = await appRequest(valid.app, {
      path: `${supplyPath()}?status=OPEN`,
    });
    assert.equal(open.status, 200);
    assert.equal(valid.listCalls[0]?.status, 'OPEN');

    const obtained = await appRequest(valid.app, {
      path: `${supplyPath()}?status=OBTAINED`,
    });
    assert.equal(obtained.status, 200);
    assert.equal(valid.listCalls[1]?.status, 'OBTAINED');

    const canceled = await appRequest(valid.app, {
      path: `${supplyPath()}?status=CANCELED`,
    });
    assert.equal(canceled.status, 200);
    assert.equal(valid.listCalls[2]?.status, 'CANCELED');

    const invalid = buildApp();
    for (const path of [
      `${supplyPath()}?status=CLAIMED`,
      `${supplyPath()}?status=open`,
      `${supplyPath()}?status=`,
      `${supplyPath()}?status=OPEN&status=CANCELED`,
    ]) {
      const res = await appRequest(invalid.app, { path });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(invalid.listCalls, []);
  });

  void it('returns 401 for unauthenticated list requests', async () => {
    const { app, listCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, { path: supplyPath() });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(listCalls, []);
  });

  void it('conceals an inaccessible Home consistently', async () => {
    const { app, listCalls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, { path: supplyPath(OTHER_HOME_ID) });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(listCalls, []);
    assertNoForbiddenLeak({
      context: 'concealed supply list',
      text: res.text,
      forbidden: leakSentinels,
    });
  });
});
