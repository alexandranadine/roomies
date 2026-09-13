import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CancelSupplyEntryInput } from '../../application/supplies/cancel-supply-entry.js';
import type { ClaimSupplyEntryInput } from '../../application/supplies/claim-supply-entry.js';
import type { CreateSupplyEntryInput } from '../../application/supplies/create-supply-entry.js';
import type { MarkSupplyEntryObtainedInput } from '../../application/supplies/mark-supply-entry-obtained.js';
import type { ReleaseSupplyClaimInput } from '../../application/supplies/release-supply-claim.js';
import { createRoomiesApiRouter } from '../../http/create-roomies-api.js';
import { UnauthenticatedError } from '../../platform/auth/errors.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { appRequest } from '../../platform/http/app-request.test-helper.js';
import {
  assertNoForbiddenLeak,
  COMMON_SECRET_SENTINELS,
} from '../../platform/http/assert-no-forbidden-leak.js';
import { createApp } from '../../platform/http/create-app.js';
import type { ApiErrorBody } from '../../platform/http/errors.js';
import {
  SupplyAlreadyClaimedError,
  SupplyClaimNotActiveError,
  SupplyNotOpenError,
} from './errors.js';
import { SUPPLY_TITLE_MAX_LENGTH } from './supply-title.js';
import { supplyClaimDtoSchema } from './supply-claim-dto.js';
import {
  supplyEntryDtoSchema,
  type SupplyEntryDto,
} from './supply-entry-dto.js';
import type { ListedSupplyEntry, SupplyClaim, SupplyEntry } from './supply.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const CLAIM_ID = '018f1e2c-7e3a-7000-8000-1234567890ad';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const HOSTILE_ORIGIN = 'https://evil.example';
const CREATED = new Date('2026-09-12T18:00:00.000Z');
const CLAIMED = new Date('2026-09-12T19:00:00.000Z');

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

function listed(overrides: Partial<ListedSupplyEntry> = {}): ListedSupplyEntry {
  return {
    ...entry(),
    activeClaim: null,
    ...overrides,
  };
}

function claim(overrides: Partial<SupplyClaim> = {}): SupplyClaim {
  return {
    id: CLAIM_ID,
    homeId: HOME_ID,
    supplyEntryId: ENTRY_ID,
    claimantMembershipId: MEMBERSHIP_ID,
    claimedAt: CLAIMED,
    releasedAt: null,
    releaseReason: null,
    createdAt: CLAIMED,
    updatedAt: CLAIMED,
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
    }) => Promise<readonly ListedSupplyEntry[]>;
    claimSupplyEntry?: (input: ClaimSupplyEntryInput) => Promise<SupplyClaim>;
    releaseSupplyClaim?: (input: ReleaseSupplyClaimInput) => Promise<void>;
    markSupplyEntryObtained?: (
      input: MarkSupplyEntryObtainedInput,
    ) => Promise<SupplyEntry>;
    cancelSupplyEntry?: (input: CancelSupplyEntryInput) => Promise<SupplyEntry>;
  } = {},
) {
  const createCalls: CreateSupplyEntryInput[] = [];
  const listCalls: {
    actor: ActiveHomeActor;
    homeId: string;
    status?: SupplyEntry['status'];
  }[] = [];
  const claimCalls: ClaimSupplyEntryInput[] = [];
  const releaseCalls: ReleaseSupplyClaimInput[] = [];
  const obtainCalls: MarkSupplyEntryObtainedInput[] = [];
  const cancelCalls: CancelSupplyEntryInput[] = [];
  return {
    createCalls,
    listCalls,
    claimCalls,
    releaseCalls,
    obtainCalls,
    cancelCalls,
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
          claimSupplyEntry: async (input) => {
            claimCalls.push(input);
            if (options.claimSupplyEntry) {
              return options.claimSupplyEntry(input);
            }
            return claim();
          },
          releaseSupplyClaim: async (input) => {
            releaseCalls.push(input);
            if (options.releaseSupplyClaim) {
              return options.releaseSupplyClaim(input);
            }
          },
          markSupplyEntryObtained: async (input) => {
            obtainCalls.push(input);
            if (options.markSupplyEntryObtained) {
              return options.markSupplyEntryObtained(input);
            }
            return entry({
              status: 'OBTAINED',
              obtainedAt: CLAIMED,
              updatedAt: CLAIMED,
            });
          },
          cancelSupplyEntry: async (input) => {
            cancelCalls.push(input);
            if (options.cancelSupplyEntry) {
              return options.cancelSupplyEntry(input);
            }
            return entry({
              status: 'CANCELED',
              canceledAt: CLAIMED,
              updatedAt: CLAIMED,
            });
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
  'activeClaim',
];

const claimDtoKeys = [
  'id',
  'supplyEntryId',
  'claimantMembershipId',
  'claimedAt',
  'releasedAt',
  'releaseReason',
];

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
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
    assert.equal(body.activeClaim, null);
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
          listed({ title: 'Open first' }),
          listed({
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
    assert.equal(body[0]?.activeClaim, null);
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

  void it('returns the evolved activeClaim projection', async () => {
    const { app } = buildApp({
      listHomeSupplies: () =>
        Promise.resolve([
          listed({
            activeClaim: {
              claimantMembershipId: MEMBERSHIP_ID,
              claimedAt: CLAIMED,
            },
          }),
        ]),
    });
    const res = await appRequest(app, { path: supplyPath() });
    assert.equal(res.status, 200);
    const body = res.json() as SupplyEntryDto[];
    assert.deepEqual(body[0]?.activeClaim, {
      claimantMembershipId: MEMBERSHIP_ID,
      claimedAt: CLAIMED.toISOString(),
    });
    assert.equal('id' in (body[0]?.activeClaim ?? {}), false);
    assert.equal('homeId' in (body[0]?.activeClaim ?? {}), false);
  });
});

function claimPath(
  homeId: string = HOME_ID,
  entryId: string = ENTRY_ID,
): string {
  return `/api/v1/homes/${homeId}/supplies/${entryId}/claim`;
}

function releasePath(
  homeId: string = HOME_ID,
  entryId: string = ENTRY_ID,
): string {
  return `/api/v1/homes/${homeId}/supplies/${entryId}/release-claim`;
}

void describe('POST /api/v1/homes/:homeId/supplies/:supplyEntryId/claim', () => {
  void it('returns 201 with the exact safe Claim DTO from a trusted Origin', async () => {
    const { app, claimCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: claimPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = supplyClaimDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), claimDtoKeys);
    assert.equal(body.supplyEntryId, ENTRY_ID);
    assert.equal(body.claimantMembershipId, MEMBERSHIP_ID);
    assert.equal(body.releasedAt, null);
    assert.equal(body.releaseReason, null);
    assert.equal('homeId' in (res.json() as object), false);
    assert.equal('userId' in (res.json() as object), false);
    assert.equal('createdAt' in (res.json() as object), false);
    assert.equal('updatedAt' in (res.json() as object), false);
    assert.deepEqual(claimCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        supplyEntryId: ENTRY_ID,
      },
    ]);
  });

  void it('accepts an absent body', async () => {
    const { app, claimCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: claimPath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 201);
    assert.equal(claimCalls.length, 1);
  });

  void it('rejects arrays, primitives, explicit null, and object properties', async () => {
    const { app, claimCalls } = buildApp();
    for (const body of [null, [], 'claim', 1, true, { extra: 1 }]) {
      const res = await appRequest(app, {
        method: 'POST',
        path: claimPath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(claimCalls, []);
  });

  void it('rejects a hostile or missing mutation Origin without invoking the command', async () => {
    const hostile = buildApp();
    const hostileRes = await appRequest(hostile.app, {
      method: 'POST',
      path: claimPath(),
      headers: {
        Origin: HOSTILE_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(hostileRes.status, 403);
    assert.deepEqual(hostile.claimCalls, []);

    const missing = buildApp();
    const missingRes = await appRequest(missing.app, {
      method: 'POST',
      path: claimPath(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missingRes.status, 403);
    assert.deepEqual(missing.claimCalls, []);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, claimCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: claimPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(claimCalls, []);
  });

  void it('maps claim conflicts without leaking claimant identity', async () => {
    const already = buildApp({
      claimSupplyEntry: () => Promise.reject(new SupplyAlreadyClaimedError()),
    });
    const claimed = await appRequest(already.app, {
      method: 'POST',
      path: claimPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(claimed.status, 409);
    assert.equal(
      (claimed.json() as ApiErrorBody).error.code,
      'SUPPLY_ALREADY_CLAIMED',
    );

    const closed = buildApp({
      claimSupplyEntry: () => Promise.reject(new SupplyNotOpenError()),
    });
    const notOpen = await appRequest(closed.app, {
      method: 'POST',
      path: claimPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(notOpen.status, 409);
    assert.equal(
      (notOpen.json() as ApiErrorBody).error.code,
      'SUPPLY_NOT_OPEN',
    );
    assertNoForbiddenLeak({
      context: 'claim conflict HTTP',
      text: `${claimed.text}\n${notOpen.text}`,
      forbidden: leakSentinels,
    });
  });

  void it('conceals an inaccessible Home', async () => {
    const { app, claimCalls } = buildApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: claimPath(OTHER_HOME_ID),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(claimCalls, []);
  });
});

void describe('POST /api/v1/homes/:homeId/supplies/:supplyEntryId/release-claim', () => {
  void it('returns empty private 204 from a trusted Origin', async () => {
    const { app, releaseCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: releasePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(releaseCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        supplyEntryId: ENTRY_ID,
      },
    ]);
  });

  void it('accepts an absent body', async () => {
    const { app, releaseCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: releasePath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 204);
    assert.equal(releaseCalls.length, 1);
  });

  void it('rejects arrays, primitives, explicit null, and object properties', async () => {
    const { app, releaseCalls } = buildApp();
    for (const body of [null, [], 'release', 1, true, { extra: 1 }]) {
      const res = await appRequest(app, {
        method: 'POST',
        path: releasePath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(releaseCalls, []);
  });

  void it('rejects a hostile or missing mutation Origin without invoking the command', async () => {
    const hostile = buildApp();
    const hostileRes = await appRequest(hostile.app, {
      method: 'POST',
      path: releasePath(),
      headers: { Origin: HOSTILE_ORIGIN },
    });
    assert.equal(hostileRes.status, 403);
    assert.deepEqual(hostile.releaseCalls, []);

    const missing = buildApp();
    const missingRes = await appRequest(missing.app, {
      method: 'POST',
      path: releasePath(),
    });
    assert.equal(missingRes.status, 403);
    assert.deepEqual(missing.releaseCalls, []);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, releaseCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: releasePath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(releaseCalls, []);
  });

  void it('maps inactive claims and conceals nonclaimant denials', async () => {
    const inactive = buildApp({
      releaseSupplyClaim: () => Promise.reject(new SupplyClaimNotActiveError()),
    });
    const inactiveRes = await appRequest(inactive.app, {
      method: 'POST',
      path: releasePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(inactiveRes.status, 409);
    assert.equal(
      (inactiveRes.json() as ApiErrorBody).error.code,
      'SUPPLY_CLAIM_NOT_ACTIVE',
    );

    const concealed = buildApp({
      releaseSupplyClaim: () => Promise.reject(new ConcealedNotFoundError()),
    });
    const concealedRes = await appRequest(concealed.app, {
      method: 'POST',
      path: releasePath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(concealedRes.status, 404);
    assert.equal((concealedRes.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assertNoForbiddenLeak({
      context: 'release HTTP',
      text: `${inactiveRes.text}\n${concealedRes.text}`,
      forbidden: leakSentinels,
    });
  });
});

function obtainPath(
  homeId: string = HOME_ID,
  entryId: string = ENTRY_ID,
): string {
  return `/api/v1/homes/${homeId}/supplies/${entryId}/obtain`;
}

function cancelPath(
  homeId: string = HOME_ID,
  entryId: string = ENTRY_ID,
): string {
  return `/api/v1/homes/${homeId}/supplies/${entryId}/cancel`;
}

void describe('POST /api/v1/homes/:homeId/supplies/:supplyEntryId/obtain', () => {
  void it('returns 200 with the authoritative SupplyEntryDto', async () => {
    const { app, obtainCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: obtainPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = supplyEntryDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), dtoKeys);
    assert.equal(body.status, 'OBTAINED');
    assert.equal(body.obtainedAt, CLAIMED.toISOString());
    assert.equal(body.canceledAt, null);
    assert.equal(body.updatedAt, CLAIMED.toISOString());
    assert.equal(body.activeClaim, null);
    assert.equal('homeId' in (res.json() as object), false);
    assert.deepEqual(obtainCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        supplyEntryId: ENTRY_ID,
      },
    ]);
  });

  void it('accepts an absent body', async () => {
    const { app, obtainCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: obtainPath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(obtainCalls.length, 1);
  });

  void it('rejects arrays, primitives, explicit null, and object properties', async () => {
    const { app, obtainCalls } = buildApp();
    for (const body of [null, [], 'obtain', 1, true, { extra: 1 }]) {
      const res = await appRequest(app, {
        method: 'POST',
        path: obtainPath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(obtainCalls, []);
  });

  void it('rejects malformed JSON as BAD_REQUEST', async () => {
    const { app, obtainCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: obtainPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: '{',
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'BAD_REQUEST');
    assert.deepEqual(obtainCalls, []);
  });

  void it('rejects a hostile or missing mutation Origin without invoking the command', async () => {
    const hostile = buildApp();
    const hostileRes = await appRequest(hostile.app, {
      method: 'POST',
      path: obtainPath(),
      headers: { Origin: HOSTILE_ORIGIN },
    });
    assert.equal(hostileRes.status, 403);
    assert.deepEqual(hostile.obtainCalls, []);

    const missing = buildApp();
    const missingRes = await appRequest(missing.app, {
      method: 'POST',
      path: obtainPath(),
    });
    assert.equal(missingRes.status, 403);
    assert.deepEqual(missing.obtainCalls, []);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, obtainCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: obtainPath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(obtainCalls, []);
  });

  void it('maps terminal conflicts and conceals missing entries', async () => {
    const conflict = buildApp({
      markSupplyEntryObtained: () => Promise.reject(new SupplyNotOpenError()),
    });
    const conflictRes = await appRequest(conflict.app, {
      method: 'POST',
      path: obtainPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(
      (conflictRes.json() as ApiErrorBody).error.code,
      'SUPPLY_NOT_OPEN',
    );
    assert.equal(
      (conflictRes.json() as ApiErrorBody).error.message,
      'Supply is not open',
    );

    const concealed = buildApp({
      markSupplyEntryObtained: () =>
        Promise.reject(new ConcealedNotFoundError()),
    });
    const concealedRes = await appRequest(concealed.app, {
      method: 'POST',
      path: obtainPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(concealedRes.status, 404);
    assert.equal((concealedRes.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assertNoForbiddenLeak({
      context: 'obtain HTTP',
      text: `${conflictRes.text}\n${concealedRes.text}`,
      forbidden: leakSentinels,
    });
  });
});

void describe('POST /api/v1/homes/:homeId/supplies/:supplyEntryId/cancel', () => {
  void it('returns 200 with the authoritative SupplyEntryDto', async () => {
    const { app, cancelCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: cancelPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = supplyEntryDtoSchema.parse(res.json());
    assert.deepEqual(Object.keys(body), dtoKeys);
    assert.equal(body.status, 'CANCELED');
    assert.equal(body.canceledAt, CLAIMED.toISOString());
    assert.equal(body.obtainedAt, null);
    assert.equal(body.updatedAt, CLAIMED.toISOString());
    assert.equal(body.activeClaim, null);
    assert.equal('homeId' in (res.json() as object), false);
    assert.deepEqual(cancelCalls, [
      {
        actor: actor(),
        homeId: HOME_ID,
        supplyEntryId: ENTRY_ID,
      },
    ]);
  });

  void it('accepts an absent body', async () => {
    const { app, cancelCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: cancelPath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(cancelCalls.length, 1);
  });

  void it('rejects arrays, primitives, explicit null, and object properties', async () => {
    const { app, cancelCalls } = buildApp();
    for (const body of [null, [], 'cancel', 1, true, { extra: 1 }]) {
      const res = await appRequest(app, {
        method: 'POST',
        path: cancelPath(),
        headers: {
          Origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
    assert.deepEqual(cancelCalls, []);
  });

  void it('rejects malformed JSON as BAD_REQUEST', async () => {
    const { app, cancelCalls } = buildApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: cancelPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: '{',
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'BAD_REQUEST');
    assert.deepEqual(cancelCalls, []);
  });

  void it('rejects a hostile or missing mutation Origin without invoking the command', async () => {
    const hostile = buildApp();
    const hostileRes = await appRequest(hostile.app, {
      method: 'POST',
      path: cancelPath(),
      headers: { Origin: HOSTILE_ORIGIN },
    });
    assert.equal(hostileRes.status, 403);
    assert.deepEqual(hostile.cancelCalls, []);

    const missing = buildApp();
    const missingRes = await appRequest(missing.app, {
      method: 'POST',
      path: cancelPath(),
    });
    assert.equal(missingRes.status, 403);
    assert.deepEqual(missing.cancelCalls, []);
  });

  void it('returns 401 for unauthenticated requests without invoking the command', async () => {
    const { app, cancelCalls } = buildApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: cancelPath(),
      headers: { Origin: TRUSTED_ORIGIN },
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(cancelCalls, []);
  });

  void it('maps terminal conflicts and conceals missing entries', async () => {
    const conflict = buildApp({
      cancelSupplyEntry: () => Promise.reject(new SupplyNotOpenError()),
    });
    const conflictRes = await appRequest(conflict.app, {
      method: 'POST',
      path: cancelPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(
      (conflictRes.json() as ApiErrorBody).error.code,
      'SUPPLY_NOT_OPEN',
    );
    assert.equal(
      (conflictRes.json() as ApiErrorBody).error.message,
      'Supply is not open',
    );

    const concealed = buildApp({
      cancelSupplyEntry: () => Promise.reject(new ConcealedNotFoundError()),
    });
    const concealedRes = await appRequest(concealed.app, {
      method: 'POST',
      path: cancelPath(),
      headers: {
        Origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(concealedRes.status, 404);
    assert.equal((concealedRes.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assertNoForbiddenLeak({
      context: 'cancel HTTP',
      text: `${conflictRes.text}\n${concealedRes.text}`,
      forbidden: leakSentinels,
    });
  });
});
