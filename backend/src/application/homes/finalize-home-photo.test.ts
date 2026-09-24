import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  ImagePolicyViolationError,
  ImageProcessorInfrastructureError,
  InvalidImageError,
} from '../../platform/image/errors.js';
import {
  ObjectStoreInfrastructureError,
  createFakeHomePhotoObjectStore,
  MAX_UPLOAD_BYTES,
} from '../../platform/object-store/index.js';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
  PayloadTooLargeError,
} from '../../platform/authz/errors.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { createCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import { createTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import type { Home } from '../../domains/homes/home.js';
import { createFinalizeHomePhoto } from './finalize-home-photo.js';
import {
  createMemoryHomePhotoPointers,
  createMemoryHomePhotoState,
  createMemoryPhotoTransaction,
  recordingProcessor,
} from './home-photo.test-helpers.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';
const GENERATION_ID = '33333333-3333-4333-8333-333333333333';
const PREVIOUS_ID = '55555555-5555-4555-8555-555555555555';

function actor(): ActiveHomeActor {
  return {
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    homeId: HOME_ID,
    role: 'ROOMMATE',
  };
}

function home(photoObjectKey: string | null = null): Home {
  return {
    id: HOME_ID,
    name: 'Oak Street',
    timezone: 'UTC',
    photoObjectKey,
  };
}

function canonical(id = GENERATION_ID): string {
  return createCanonicalHomePhotoObjectKey(HOME_ID, () => id);
}

function tempKey(): string {
  return createTempHomePhotoObjectKey(HOME_ID, () => UPLOAD_ID);
}

function webpResult(bytes = Buffer.from('webp-out')) {
  return {
    bytes: Uint8Array.from(bytes),
    width: 32,
    height: 32,
    contentType: 'image/webp' as const,
  };
}

function commandOf(input: {
  existingKey?: string | null;
  failCommit?: boolean;
  failReplace?: boolean;
  membershipEnded?: boolean;
  archived?: boolean;
  processor?: Parameters<typeof createFinalizeHomePhoto>[0]['imageProcessor'];
  store?: ReturnType<typeof createFakeHomePhotoObjectStore>;
  onLock?: () => Promise<void>;
  generateCanonicalKey?: (homeId: string) => string;
}) {
  const current = actor();
  const state = createMemoryHomePhotoState({
    home: home(input.existingKey ?? null),
    actor: current,
  });
  state.membershipEnded = input.membershipEnded === true;
  state.archived = input.archived === true;
  const store = input.store ?? createFakeHomePhotoObjectStore();
  const processor =
    input.processor ??
    recordingProcessor({
      process: () => Promise.resolve(webpResult()),
    });
  const finalize = createFinalizeHomePhoto({
    runTransaction: createMemoryPhotoTransaction(state, {
      failCommit: input.failCommit,
    }),
    pointers: createMemoryHomePhotoPointers(state, {
      onLock: input.onLock,
      failReplace: input.failReplace,
    }),
    objectStore: store,
    imageProcessor: processor,
    generateCanonicalKey:
      input.generateCanonicalKey ?? ((homeId) => canonical()),
  });
  return { finalize, state, store, processor };
}

void describe('createFinalizeHomePhoto', () => {
  void it('writes a canonical pointer and deletes temp plus previous after commit', async () => {
    const previous = canonical(PREVIOUS_ID);
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old-photo'));
    store.seed(tempKey(), Buffer.from('jpeg'));
    const { finalize, state } = commandOf({ store, existingKey: previous });
    const result = await finalize({
      actor: actor(),
      homeId: HOME_ID,
      uploadId: UPLOAD_ID,
    });
    assert.equal(result.photoObjectKey, canonical());
    assert.equal(state.home.photoObjectKey, canonical());
    assert.equal(store.getStored(tempKey()), undefined);
    assert.equal(store.getStored(previous), undefined);
    assert.ok(store.getStored(canonical()));
    assert.equal(store.calls.delete.includes(tempKey()), true);
    assert.equal(store.calls.delete.includes(previous), true);
    assert.equal(store.calls.delete.includes(canonical()), false);
  });

  void it('processes valid JPEG, PNG, and WebP temps', async () => {
    const { createSharpHomePhotoImageProcessor } = await import(
      '../../platform/image/sharp-processor.js'
    );
    const sharp = (await import('sharp')).default;
    const formats = [
      await sharp({
        create: { width: 32, height: 24, channels: 3, background: 'red' },
      })
        .jpeg()
        .toBuffer(),
      await sharp({
        create: { width: 32, height: 24, channels: 4, background: 'green' },
      })
        .png()
        .toBuffer(),
      await sharp({
        create: { width: 32, height: 24, channels: 3, background: 'blue' },
      })
        .webp()
        .toBuffer(),
    ];
    for (const bytes of formats) {
      const uploadId = randomUUID();
      const store = createFakeHomePhotoObjectStore();
      store.seed(createTempHomePhotoObjectKey(HOME_ID, () => uploadId), bytes);
      const { finalize, state } = commandOf({
        store,
        processor: createSharpHomePhotoImageProcessor(),
        generateCanonicalKey: (targetHomeId) =>
          createCanonicalHomePhotoObjectKey(targetHomeId),
      });
      const result = await finalize({
        actor: actor(),
        homeId: HOME_ID,
        uploadId,
      });
      assert.equal(result.photoObjectKey !== null, true);
      assert.equal(state.home.photoObjectKey?.endsWith('.webp'), true);
      assert.equal(state.home.photoObjectKey?.startsWith('tmp/'), false);
    }
  });

  void it('rejects malformed, spoofed, animated, and unsupported decoded images', async () => {
    const { createSharpHomePhotoImageProcessor } = await import(
      '../../platform/image/sharp-processor.js'
    );
    const sharp = (await import('sharp')).default;
    const processor = createSharpHomePhotoImageProcessor();
    const animated = await sharp({
      create: { width: 8, height: 8, channels: 4, background: 'red' },
    })
      .gif()
      .toBuffer();
    const spoofed = Buffer.concat([
      Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
      Buffer.from('not-a-gif'),
    ]);
    const unsupported = await sharp({
      create: { width: 8, height: 8, channels: 3, background: 'red' },
    })
      .tiff()
      .toBuffer();
    for (const bytes of [
      Buffer.from('not-an-image'),
      animated,
      spoofed,
      unsupported,
    ]) {
      const uploadId = randomUUID();
      const store = createFakeHomePhotoObjectStore();
      store.seed(createTempHomePhotoObjectKey(HOME_ID, () => uploadId), bytes);
      const { finalize } = commandOf({ store, processor });
      await assert.rejects(
        () =>
          finalize({ actor: actor(), homeId: HOME_ID, uploadId }),
        InvalidRequestError,
      );
    }
  });

  void it('never writes a temp key as the Home pointer', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(tempKey(), Buffer.from('jpeg'));
    const { finalize, state } = commandOf({
      store,
      generateCanonicalKey: () => tempKey(),
    });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      AuthorizationIntegrityError,
    );
    assert.equal(state.home.photoObjectKey, null);
  });

  void it('returns 400-equivalent for missing temp and still cleans temp', async () => {
    const { finalize, store } = commandOf({});
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      InvalidRequestError,
    );
    assert.equal(store.calls.delete.includes(tempKey()), true);
  });

  void it('rejects oversized temp without calling Sharp', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(tempKey(), Buffer.alloc(4), MAX_UPLOAD_BYTES + 1);
    const processor = recordingProcessor();
    const { finalize } = commandOf({ store, processor });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      PayloadTooLargeError,
    );
    assert.equal(processor.calls, 0);
  });

  void it('maps malformed, spoofed, animated, and unsupported images to invalid', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(tempKey(), Buffer.from('not-an-image'));
    const { finalize } = commandOf({
      store,
      processor: { process: () => Promise.reject(new InvalidImageError()) },
    });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      InvalidRequestError,
    );
  });

  void it('maps pixel, dimension, and encoded-size policy failures to invalid', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(tempKey(), Buffer.from('big'));
    const { finalize } = commandOf({
      store,
      processor: {
        process: () => Promise.reject(new ImagePolicyViolationError()),
      },
    });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      InvalidRequestError,
    );
  });

  void it('maps Sharp infrastructure failure without changing the pointer', async () => {
    const previous = canonical(PREVIOUS_ID);
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    store.seed(tempKey(), Buffer.from('jpeg'));
    const { finalize, state } = commandOf({
      store,
      existingKey: previous,
      processor: {
        process: () =>
          Promise.reject(new ImageProcessorInfrastructureError()),
      },
    });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      ImageProcessorInfrastructureError,
    );
    assert.equal(state.home.photoObjectKey, previous);
    assert.ok(store.getStored(previous));
  });

  void it('deletes the new canonical and keeps the old pointer when membership ends before lock', async () => {
    const previous = canonical(PREVIOUS_ID);
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    store.seed(tempKey(), Buffer.from('jpeg'));
    const { finalize, state } = commandOf({
      store,
      existingKey: previous,
      membershipEnded: true,
    });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      ConcealedNotFoundError,
    );
    assert.equal(state.home.photoObjectKey, previous);
    assert.ok(store.getStored(previous));
    assert.equal(store.getStored(canonical()), undefined);
    assert.equal(store.calls.delete.includes(canonical()), true);
    assert.equal(store.calls.delete.includes(previous), false);
  });

  void it('deletes the new canonical when the Home is archived before lock', async () => {
    const previous = canonical(PREVIOUS_ID);
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    store.seed(tempKey(), Buffer.from('jpeg'));
    const { finalize, state } = commandOf({
      store,
      existingKey: previous,
      archived: true,
    });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      ConcealedNotFoundError,
    );
    assert.equal(state.home.photoObjectKey, previous);
    assert.ok(store.getStored(previous));
    assert.equal(store.getStored(canonical()), undefined);
  });

  void it('deletes the new canonical when UPDATE fails', async () => {
    const previous = canonical(PREVIOUS_ID);
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    store.seed(tempKey(), Buffer.from('jpeg'));
    const { finalize, state } = commandOf({
      store,
      existingKey: previous,
      failReplace: true,
    });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      TransactionInfrastructureError,
    );
    assert.equal(state.home.photoObjectKey, previous);
    assert.ok(store.getStored(previous));
    assert.equal(store.getStored(canonical()), undefined);
  });

  void it('deletes the new canonical when commit fails', async () => {
    const previous = canonical(PREVIOUS_ID);
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    store.seed(tempKey(), Buffer.from('jpeg'));
    const { finalize, state } = commandOf({
      store,
      existingKey: previous,
      failCommit: true,
    });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      TransactionInfrastructureError,
    );
    assert.equal(state.home.photoObjectKey, previous);
    assert.ok(store.getStored(previous));
    assert.equal(store.getStored(canonical()), undefined);
  });

  void it('does not undo a committed pointer when post-commit cleanup fails', async () => {
    const previous = canonical(PREVIOUS_ID);
    const store = createFakeHomePhotoObjectStore();
    store.seed(previous, Buffer.from('old'));
    store.seed(tempKey(), Buffer.from('jpeg'));
    store.failNext('delete');
    const { finalize, state } = commandOf({ store, existingKey: previous });
    const result = await finalize({
      actor: actor(),
      homeId: HOME_ID,
      uploadId: UPLOAD_ID,
    });
    assert.equal(result.photoObjectKey, canonical());
    assert.equal(state.home.photoObjectKey, canonical());
  });

  void it('derives the temp key from the authorized Home, not another Home upload', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(
      createTempHomePhotoObjectKey(OTHER_HOME_ID, () => UPLOAD_ID),
      Buffer.from('other-home'),
    );
    const { finalize } = commandOf({ store });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      InvalidRequestError,
    );
    assert.deepEqual(store.calls.get, [tempKey()]);
  });

  void it('best-effort deletes temp after a failed canonical put', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(tempKey(), Buffer.from('jpeg'));
    store.failNext('put');
    const { finalize, state } = commandOf({ store });
    await assert.rejects(
      () =>
        finalize({ actor: actor(), homeId: HOME_ID, uploadId: UPLOAD_ID }),
      ObjectStoreInfrastructureError,
    );
    assert.equal(state.home.photoObjectKey, null);
    assert.equal(store.calls.delete.includes(tempKey()), true);
  });

  void it('denies a Home-scope mismatch before object work', async () => {
    const store = createFakeHomePhotoObjectStore();
    store.seed(tempKey(), Buffer.from('jpeg'));
    const { finalize } = commandOf({ store });
    await assert.rejects(
      () =>
        finalize({
          actor: { ...actor(), homeId: OTHER_HOME_ID },
          homeId: HOME_ID,
          uploadId: UPLOAD_ID,
        }),
      ConcealedNotFoundError,
    );
    assert.deepEqual(store.calls.get, []);
    assert.deepEqual(store.calls.put, []);
  });
});
