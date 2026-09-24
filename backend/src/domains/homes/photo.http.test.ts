import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDeleteHomePhoto } from '../../application/homes/delete-home-photo.js';
import { createFinalizeHomePhoto } from '../../application/homes/finalize-home-photo.js';
import { createGetHomePhoto } from '../../application/homes/get-home-photo.js';
import {
  createMemoryHomePhotoPointers,
  createMemoryHomePhotoState,
  createMemoryPhotoTransaction,
  recordingProcessor,
} from '../../application/homes/home-photo.test-helpers.js';
import { createRequestHomePhotoUpload } from '../../application/homes/request-home-photo-upload.js';
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
import { createInMemoryRateLimitRuntime } from '../../platform/http/rate-limit.js';
import {
  ImagePolicyViolationError,
  ImageProcessorInfrastructureError,
  InvalidImageError,
} from '../../platform/image/errors.js';
import type { HomePhotoImageProcessor } from '../../platform/image/index.js';
import {
  createFakeHomePhotoObjectStore,
  MAX_UPLOAD_BYTES,
  type FakeHomePhotoObjectStore,
} from '../../platform/object-store/index.js';
import { createCanonicalHomePhotoObjectKey } from './photo-object-key.js';
import { createTempHomePhotoObjectKey } from './temp-photo-object-key.js';
import type { Home } from './home.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';
const GENERATION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_UPLOAD_ID = '44444444-4444-4444-8444-444444444444';
const TRUSTED_ORIGIN = 'http://localhost:5173';
const FIXED_NOW = new Date('2026-09-23T18:00:00.000Z');

function actor(role: ActiveHomeActor['role'] = 'ROOMMATE'): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role,
  };
}

function home(photoObjectKey: string | null = null): Home {
  return {
    id: HOME_ID,
    name: 'Oak Street',
    timezone: 'America/Los_Angeles',
    photoObjectKey,
  };
}

const leakSentinels = [
  ...COMMON_SECRET_SENTINELS,
  MEMBERSHIP_ID,
  USER_ID,
  'photoObjectKey',
  'photo_object_key',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ACCOUNT_ID',
  'accessKeyId',
  'secretAccessKey',
  'HOME_SCOPE_MISMATCH',
];

function unusedHomeCommands() {
  return {
    archiveFinalMemberHome: () =>
      Promise.reject(new Error('archive must not run for home photo')),
    changeMembershipRole: () =>
      Promise.reject(new Error('role change must not run for home photo')),
    leaveMembership: () =>
      Promise.reject(new Error('leave must not run for home photo')),
    removeMembership: () =>
      Promise.reject(new Error('remove must not run for home photo')),
  };
}

function processedWebp(): Uint8Array {
  return Uint8Array.from(Buffer.from('RIFF....WEBP'));
}

function buildPhotoApp(
  options: {
    requirePrincipal?: PrincipalResolver['requirePrincipal'];
    resolve?: (input: {
      userId: string;
      homeId: string;
    }) => Promise<ActiveHomeActor | null>;
    role?: ActiveHomeActor['role'];
    store?: FakeHomePhotoObjectStore;
    processor?: HomePhotoImageProcessor;
    existingKey?: string | null;
    failCommit?: boolean;
    failReplace?: boolean;
    onLock?: () => Promise<void>;
    rateLimits?: ReturnType<typeof createInMemoryRateLimitRuntime>;
  } = {},
) {
  const currentActor = actor(options.role ?? 'ROOMMATE');
  const state = createMemoryHomePhotoState({
    home: home(options.existingKey ?? null),
    actor: currentActor,
  });
  const store =
    options.store ?? createFakeHomePhotoObjectStore({ now: () => FIXED_NOW });
  const processor = options.processor ?? recordingProcessor();
  const pointers = createMemoryHomePhotoPointers(state, {
    onLock: options.onLock,
    failReplace: options.failReplace,
  });
  const requestHomePhotoUpload = createRequestHomePhotoUpload({
    objectStore: store,
    generateUploadId: () => UPLOAD_ID,
  });
  const finalizeHomePhoto = createFinalizeHomePhoto({
    runTransaction: createMemoryPhotoTransaction(state, {
      failCommit: options.failCommit,
    }),
    pointers,
    objectStore: store,
    imageProcessor: processor,
    generateCanonicalKey: (homeId) =>
      createCanonicalHomePhotoObjectKey(homeId, () => GENERATION_ID),
  });
  const getHomePhoto = createGetHomePhoto({
    homes: {
      findActiveHomeById: (homeId) =>
        Promise.resolve(homeId === state.home.id ? { ...state.home } : null),
    },
    objectStore: store,
  });
  const deleteHomePhoto = createDeleteHomePhoto({
    runTransaction: createMemoryPhotoTransaction(state, {
      failCommit: options.failCommit,
    }),
    pointers,
    objectStore: store,
  });

  return {
    store,
    state,
    processor,
    app: createApp({
      config: { trustedOrigins: [TRUSTED_ORIGIN], trustProxyHops: 0 },
      readiness: { checkReady: () => Promise.resolve(true) },
      rateLimits: options.rateLimits,
      roomiesApi: createRoomiesApiRouter({
        principalResolver: {
          requirePrincipal:
            options.requirePrincipal ??
            (() => Promise.resolve({ userId: USER_ID })),
        },
        activeHomeActorResolver: {
          resolve:
            options.resolve ??
            (({ homeId }) =>
              Promise.resolve(
                homeId === HOME_ID ? { ...currentActor } : null,
              )),
        },
        homeReader: {
          findActiveHomeById: (homeId) =>
            Promise.resolve(homeId === state.home.id ? { ...state.home } : null),
        },
        ...unusedHomeCommands(),
        rateLimits: options.rateLimits,
        photo: {
          requestHomePhotoUpload,
          finalizeHomePhoto,
          getHomePhoto,
          deleteHomePhoto,
        },
      }),
    }),
  };
}

function mutationHeaders(): Record<string, string> {
  return {
    Origin: TRUSTED_ORIGIN,
    'content-type': 'application/json',
  };
}

void describe('POST /api/v1/homes/:homeId/photo/uploads', () => {
  void it('returns 401 for unauthenticated requests without signing', async () => {
    const { app, store } = buildPhotoApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
      headers: mutationHeaders(),
      body: JSON.stringify({ contentType: 'image/jpeg', byteSize: 1024 }),
    });
    assert.equal(res.status, 401);
    assert.equal((res.json() as ApiErrorBody).error.code, 'UNAUTHENTICATED');
    assert.deepEqual(store.calls.signPut, []);
  });

  void it('returns 400 for a malformed Home UUID', async () => {
    const { app, store } = buildPhotoApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: '/api/v1/homes/not-a-uuid/photo/uploads',
      headers: mutationHeaders(),
      body: JSON.stringify({ contentType: 'image/jpeg', byteSize: 1024 }),
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_PATH_INPUT');
    assert.deepEqual(store.calls.signPut, []);
  });

  void it('returns 400 for extra JSON fields and bad content types', async () => {
    const { app } = buildPhotoApp();
    const extra = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
      headers: mutationHeaders(),
      body: JSON.stringify({
        contentType: 'image/jpeg',
        byteSize: 1024,
        key: 'tmp/homes/secret',
      }),
    });
    assert.equal(extra.status, 400);
    assert.equal((extra.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    const badType = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
      headers: mutationHeaders(),
      body: JSON.stringify({ contentType: 'image/heic', byteSize: 1024 }),
    });
    assert.equal(badType.status, 400);
    assert.equal((badType.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
  });

  void it('accepts byteSize 8388608 and rejects 8388609 with 413', async () => {
    const { app } = buildPhotoApp();
    const accepted = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
      headers: mutationHeaders(),
      body: JSON.stringify({
        contentType: 'image/jpeg',
        byteSize: MAX_UPLOAD_BYTES,
      }),
    });
    assert.equal(accepted.status, 201);
    const rejected = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
      headers: mutationHeaders(),
      body: JSON.stringify({
        contentType: 'image/jpeg',
        byteSize: MAX_UPLOAD_BYTES + 1,
      }),
    });
    assert.equal(rejected.status, 413);
    assert.equal(
      (rejected.json() as ApiErrorBody).error.code,
      'PAYLOAD_TOO_LARGE',
    );
  });

  void it('returns 201 for ROOMMATE and ADMIN without leaking keys', async () => {
    for (const role of ['ROOMMATE', 'ADMIN'] as const) {
      const { app } = buildPhotoApp({ role });
      const res = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
        headers: mutationHeaders(),
        body: JSON.stringify({ contentType: 'image/png', byteSize: 2048 }),
      });
      assert.equal(res.status, 201);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const body = res.json() as {
        uploadId: string;
        uploadUrl: string;
        expiresAt: string;
        requiredHeaders: { 'Content-Type': string };
      };
      assert.equal(body.uploadId, UPLOAD_ID);
      assert.equal(body.requiredHeaders['Content-Type'], 'image/png');
      assert.equal('Content-Length' in body.requiredHeaders, false);
      assert.deepEqual(Object.keys(body), [
        'uploadId',
        'uploadUrl',
        'expiresAt',
        'requiredHeaders',
      ]);
      assert.equal('key' in body, false);
      assert.equal('photoObjectKey' in body, false);
      assertNoForbiddenLeak({
        context: `${role} upload intent`,
        text: JSON.stringify({
          uploadId: body.uploadId,
          expiresAt: body.expiresAt,
          requiredHeaders: body.requiredHeaders,
        }),
        forbidden: leakSentinels,
      });
    }
  });

  void it('conceals cross-Home authorization and does not sign', async () => {
    const { app, store } = buildPhotoApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${OTHER_HOME_ID}/photo/uploads`,
      headers: mutationHeaders(),
      body: JSON.stringify({ contentType: 'image/jpeg', byteSize: 1024 }),
    });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(store.calls.signPut, []);
    assertNoForbiddenLeak({
      context: 'upload concealed 404',
      text: res.text,
      forbidden: [...leakSentinels, 'tmp/homes', OTHER_UPLOAD_ID],
    });
  });
});

void describe('POST /api/v1/homes/:homeId/photo', () => {
  async function postFinalize(
    app: ReturnType<typeof buildPhotoApp>['app'],
    uploadId = UPLOAD_ID,
  ) {
    return appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${HOME_ID}/photo`,
      headers: mutationHeaders(),
      body: JSON.stringify({ uploadId }),
    });
  }

  void it('finalizes a valid temp object and returns hasPhoto true', async () => {
    const store = createFakeHomePhotoObjectStore({ now: () => FIXED_NOW });
    const tempKey = createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID);
    store.seed(tempKey, Buffer.from('jpeg-bytes'));
    const { app, state } = buildPhotoApp({
      store,
      processor: recordingProcessor({
        process: () =>
          Promise.resolve({
            bytes: processedWebp(),
            width: 32,
            height: 32,
            contentType: 'image/webp',
          }),
      }),
    });
    const res = await postFinalize(app);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'America/Los_Angeles',
      hasPhoto: true,
    });
    const canonical = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => GENERATION_ID,
    );
    assert.equal(state.home.photoObjectKey, canonical);
    assert.equal(isTemp(state.home.photoObjectKey), false);
    assert.equal(store.getStored(tempKey), undefined);
    assert.ok(store.getStored(canonical));
    assertNoForbiddenLeak({
      context: 'finalize 200',
      text: res.text,
      forbidden: [...leakSentinels, canonical, 'tmp/homes', '.webp'],
    });
  });

  void it('returns 401 for unauthenticated finalize requests', async () => {
    const { app, store } = buildPhotoApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await postFinalize(app);
    assert.equal(res.status, 401);
    assert.deepEqual(store.calls.get, []);
  });

  void it('returns 400 for extra finalize JSON fields', async () => {
    const { app } = buildPhotoApp();
    const res = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${HOME_ID}/photo`,
      headers: mutationHeaders(),
      body: JSON.stringify({ uploadId: UPLOAD_ID, key: 'homes/secret.webp' }),
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
  });

  void it('returns 400 when the temp object is missing', async () => {
    const { app } = buildPhotoApp();
    const res = await postFinalize(app);
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
  });

  void it('returns 413 for an oversized temp and does not call Sharp', async () => {
    const store = createFakeHomePhotoObjectStore();
    const tempKey = createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID);
    store.seed(tempKey, Buffer.alloc(8), MAX_UPLOAD_BYTES + 1);
    const processor = recordingProcessor();
    const { app } = buildPhotoApp({ store, processor });
    const res = await postFinalize(app);
    assert.equal(res.status, 413);
    assert.equal((res.json() as ApiErrorBody).error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(processor.calls, 0);
  });

  void it('maps image policy and invalid images to 400', async () => {
    const cases: Array<{ error: Error; label: string }> = [
      { error: new InvalidImageError(), label: 'invalid' },
      { error: new ImagePolicyViolationError(), label: 'policy' },
    ];
    for (const testCase of cases) {
      const store = createFakeHomePhotoObjectStore();
      store.seed(
        createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID),
        Buffer.from('bytes'),
      );
      const { app } = buildPhotoApp({
        store,
        processor: {
          process: () => Promise.reject(testCase.error),
        },
      });
      const res = await postFinalize(app);
      assert.equal(res.status, 400, testCase.label);
      assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
    }
  });

  void it('maps Sharp infrastructure failure to 500', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(
      createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID),
      Buffer.from('bytes'),
    );
    const { app } = buildPhotoApp({
      store,
      processor: {
        process: () => Promise.reject(new ImageProcessorInfrastructureError()),
      },
    });
    const res = await postFinalize(app);
    assert.equal(res.status, 500);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INTERNAL_ERROR');
  });

  void it('leaves the DB pointer untouched when canonical PutObject fails', async () => {
    const store = createFakeHomePhotoObjectStore();
    const previous = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => '55555555-5555-4555-8555-555555555555',
    );
    store.seed(previous, Buffer.from('old'));
    store.seed(
      createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID),
      Buffer.from('bytes'),
    );
    store.failNext('put');
    const { app, state } = buildPhotoApp({
      store,
      existingKey: previous,
      processor: recordingProcessor({
        process: () =>
          Promise.resolve({
            bytes: processedWebp(),
            width: 32,
            height: 32,
            contentType: 'image/webp',
          }),
      }),
    });
    const res = await postFinalize(app);
    assert.equal(res.status, 500);
    assert.equal(state.home.photoObjectKey, previous);
    assert.ok(store.getStored(previous));
  });

  void it('cannot consume another Home temp object from this Home uploadId', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(
      createTempHomePhotoObjectKey(OTHER_HOME_ID, () => UPLOAD_ID),
      Buffer.from('home-a-bytes'),
    );
    const { app, store: used } = buildPhotoApp({ store });
    const res = await postFinalize(app);
    assert.equal(res.status, 400);
    assert.equal(
      used.calls.get.includes(
        createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID),
      ),
      true,
    );
    assert.equal(
      used.calls.get.includes(
        createTempHomePhotoObjectKey(OTHER_HOME_ID, () => UPLOAD_ID),
      ),
      false,
    );
  });
});

void describe('GET /api/v1/homes/:homeId/photo', () => {
  void it('returns 401 for unauthenticated requests', async () => {
    const { app, store } = buildPhotoApp({
      requirePrincipal: () => Promise.reject(new UnauthenticatedError()),
    });
    const res = await appRequest(app, {
      path: `/api/v1/homes/${HOME_ID}/photo`,
    });
    assert.equal(res.status, 401);
    assert.deepEqual(store.calls.signGet, []);
  });

  void it('returns a signed GET for ROOMMATE and ADMIN', async () => {
    const canonical = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => GENERATION_ID,
    );
    for (const role of ['ROOMMATE', 'ADMIN'] as const) {
      const { app, store } = buildPhotoApp({
        role,
        existingKey: canonical,
      });
      const res = await appRequest(app, {
        path: `/api/v1/homes/${HOME_ID}/photo`,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const body = res.json() as {
        downloadUrl: string;
        contentType: string;
        expiresAt: string;
      };
      assert.equal(body.contentType, 'image/webp');
      assert.deepEqual(Object.keys(body), [
        'downloadUrl',
        'contentType',
        'expiresAt',
      ]);
      assert.equal(store.calls.signGet.includes(canonical), true);
      assertNoForbiddenLeak({
        context: `${role} photo GET`,
        text: JSON.stringify({
          contentType: body.contentType,
          expiresAt: body.expiresAt,
        }),
        forbidden: [...leakSentinels, canonical],
      });
    }
  });

  void it('returns 204 and does not sign when the Home has no photo', async () => {
    const { app, store } = buildPhotoApp();
    const res = await appRequest(app, {
      path: `/api/v1/homes/${HOME_ID}/photo`,
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.deepEqual(store.calls.signGet, []);
  });

  void it('conceals unauthorized Homes without signing', async () => {
    const { app, store } = buildPhotoApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, {
      path: `/api/v1/homes/${OTHER_HOME_ID}/photo`,
    });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.deepEqual(store.calls.signGet, []);
  });
});

void describe('DELETE /api/v1/homes/:homeId/photo', () => {
  void it('allows ROOMMATE and ADMIN to delete after commit', async () => {
    for (const role of ['ROOMMATE', 'ADMIN'] as const) {
      const previous = createCanonicalHomePhotoObjectKey(
        HOME_ID,
        () => GENERATION_ID,
      );
      const store = createFakeHomePhotoObjectStore();
      store.seed(previous, Buffer.from('old'));
      const { app, state } = buildPhotoApp({
        role,
        store,
        existingKey: previous,
      });
      const res = await appRequest(app, {
        method: 'DELETE',
        path: `/api/v1/homes/${HOME_ID}/photo`,
        headers: mutationHeaders(),
        body: '{}',
      });
      assert.equal(res.status, 204);
      assert.equal(state.home.photoObjectKey, null);
      assert.equal(store.getStored(previous), undefined);
      assert.equal(store.calls.delete.includes(previous), true);
    }
  });

  void it('is idempotent when the pointer is already null', async () => {
    const { app, store } = buildPhotoApp();
    const first = await appRequest(app, {
      method: 'DELETE',
      path: `/api/v1/homes/${HOME_ID}/photo`,
      headers: mutationHeaders(),
      body: '{}',
    });
    const second = await appRequest(app, {
      method: 'DELETE',
      path: `/api/v1/homes/${HOME_ID}/photo`,
      headers: mutationHeaders(),
    });
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    assert.deepEqual(store.calls.delete, []);
  });

  void it('does not delete the object when the transaction fails', async () => {
    const previous = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => GENERATION_ID,
    );
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    const { app, state } = buildPhotoApp({
      store,
      existingKey: previous,
      failCommit: true,
    });
    const res = await appRequest(app, {
      method: 'DELETE',
      path: `/api/v1/homes/${HOME_ID}/photo`,
      headers: mutationHeaders(),
      body: '{}',
    });
    assert.equal(res.status, 500);
    assert.equal(state.home.photoObjectKey, previous);
    assert.ok(store.getStored(previous));
    assert.deepEqual(store.calls.delete, []);
  });

  void it('conceals ended, cross-Home, and archived authorization', async () => {
    const { app } = buildPhotoApp({
      resolve: () => Promise.resolve(null),
    });
    const res = await appRequest(app, {
      method: 'DELETE',
      path: `/api/v1/homes/${HOME_ID}/photo`,
      headers: mutationHeaders(),
      body: '{}',
    });
    assert.equal(res.status, 404);
    assert.equal((res.json() as ApiErrorBody).error.code, 'NOT_FOUND');
  });

  void it('rejects extra delete body fields', async () => {
    const { app } = buildPhotoApp();
    const res = await appRequest(app, {
      method: 'DELETE',
      path: `/api/v1/homes/${HOME_ID}/photo`,
      headers: mutationHeaders(),
      body: JSON.stringify({ key: 'homes/secret.webp' }),
    });
    assert.equal(res.status, 400);
    assert.equal((res.json() as ApiErrorBody).error.code, 'INVALID_REQUEST');
  });
});

void describe('Home photo sensitive rate limit', () => {
  void it('limits upload, finalize, and delete but not GET', async () => {
    const rateLimits = createInMemoryRateLimitRuntime({
      policies: { sensitive: { max: 1, windowMs: 60_000 } },
    });
    const { app } = buildPhotoApp({ rateLimits });
    try {
      const first = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
        headers: mutationHeaders(),
        body: JSON.stringify({ contentType: 'image/jpeg', byteSize: 12 }),
      });
      assert.equal(first.status, 201);
      const blocked = await appRequest(app, {
        method: 'POST',
        path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
        headers: mutationHeaders(),
        body: JSON.stringify({ contentType: 'image/jpeg', byteSize: 12 }),
      });
      assert.equal(blocked.status, 429);
      const get = await appRequest(app, {
        path: `/api/v1/homes/${HOME_ID}/photo`,
      });
      assert.equal(get.status, 204);
    } finally {
      rateLimits.stop();
    }
  });
});

function isTemp(key: string | null): boolean {
  return key !== null && key.startsWith('tmp/');
}

void describe('Home photo policy denial', () => {
  void it('does not invoke photo commands when Home context conceals', async () => {
    const { app } = buildPhotoApp({
      resolve: () => Promise.reject(new ConcealedNotFoundError()),
    });
    const res = await appRequest(app, {
      method: 'POST',
      path: `/api/v1/homes/${HOME_ID}/photo/uploads`,
      headers: mutationHeaders(),
      body: JSON.stringify({ contentType: 'image/jpeg', byteSize: 12 }),
    });
    assert.equal(res.status, 404);
  });
});
