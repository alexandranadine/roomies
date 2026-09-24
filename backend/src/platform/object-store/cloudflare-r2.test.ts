import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { createCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import { createCloudflareR2ObjectStore } from './cloudflare-r2.js';
import {
  ObjectNotFoundError,
  ObjectStoreInfrastructureError,
  ObjectTooLargeError,
} from './errors.js';
import { MAX_UPLOAD_BYTES } from './types.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIXED_ID = '11111111-1111-4111-8111-111111111111';

const R2_CONFIG = {
  provider: 'cloudflare' as const,
  accountId: 'test-account',
  accessKeyId: 'test-access',
  secretAccessKey: 'test-secret',
  bucket: 'roomies-home-photos',
  s3Endpoint: 'https://test-account.r2.cloudflarestorage.com',
  region: 'auto',
};

void describe('cloudflare R2 object store', () => {
  void it('maps missing objects and infrastructure failures without leaking AWS details', async () => {
    const missing = Object.assign(
      new Error('The specified key does not exist'),
      {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      },
    );
    const store = createCloudflareR2ObjectStore({
      config: R2_CONFIG,
      client: {
        send: () => Promise.reject(missing),
      } as unknown as S3Client,
    });
    await assert.rejects(
      () => store.getObjectBounded({ key: 'tmp/missing' }),
      (error: unknown) => {
        assert.ok(error instanceof ObjectNotFoundError);
        assert.equal(
          error.message.includes('The specified key does not exist'),
          false,
        );
        return true;
      },
    );

    const broken = createCloudflareR2ObjectStore({
      config: R2_CONFIG,
      client: {
        send: () => Promise.reject(new Error('socket hang up at r2.internal')),
      } as unknown as S3Client,
    });
    await assert.rejects(
      () => broken.deleteObject({ key: 'anything' }),
      (error: unknown) => {
        assert.ok(error instanceof ObjectStoreInfrastructureError);
        assert.equal(error.message.includes('socket hang up'), false);
        assert.equal(error.message.includes('r2.internal'), false);
        return true;
      },
    );
  });

  void it('rejects oversized GetObject bodies using untrusted ContentLength first', async () => {
    let pulled = 0;
    const body = {
      *[Symbol.iterator]() {
        pulled += 1;
        yield Buffer.alloc(64, 9);
      },
    };
    const store = createCloudflareR2ObjectStore({
      config: R2_CONFIG,
      client: {
        send: (command: unknown) => {
          assert.ok(command instanceof GetObjectCommand);
          return Promise.resolve({
            ContentLength: MAX_UPLOAD_BYTES + 1,
            Body: body,
          });
        },
      } as unknown as S3Client,
    });
    await assert.rejects(
      () => store.getObjectBounded({ key: 'tmp/oversized' }),
      ObjectTooLargeError,
    );
    assert.equal(pulled, 0);
  });

  void it('puts canonical objects as private webp', async () => {
    const key = createCanonicalHomePhotoObjectKey(HOME_ID, () => FIXED_ID);
    const sent: unknown[] = [];
    const store = createCloudflareR2ObjectStore({
      config: R2_CONFIG,
      client: {
        send: (command: unknown) => {
          sent.push(command);
          return Promise.resolve({});
        },
      } as unknown as S3Client,
    });
    await store.putCanonicalObject({
      homeId: HOME_ID,
      key,
      body: Buffer.from('webp-bytes'),
    });
    const command = sent[0] as { input?: Record<string, unknown> };
    assert.equal(command.input?.Key, key);
    assert.equal(command.input?.ContentType, 'image/webp');
    assert.equal(command.input?.CacheControl, 'private, no-store');
  });

  void it('reads a stream body without transformToByteArray', async () => {
    const store = createCloudflareR2ObjectStore({
      config: R2_CONFIG,
      client: {
        send: () =>
          Promise.resolve({
            ContentLength: 4,
            Body: Readable.from([Buffer.from('abcd')]),
          }),
      } as unknown as S3Client,
    });
    const bytes = await store.getObjectBounded({ key: 'tmp/small' });
    assert.equal(Buffer.from(bytes).toString(), 'abcd');
  });
});
