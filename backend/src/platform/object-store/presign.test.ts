import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import { createTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import { createCloudflareR2ObjectStore } from './cloudflare-r2.js';
import { InvalidObjectStoreRequestError } from './errors.js';
import { createFakeHomePhotoObjectStore } from './fake-store.js';
import {
  HOME_PHOTO_CACHE_CONTROL,
  HOME_PHOTO_WEBP_CONTENT_TYPE,
  PRESIGNED_GET_EXPIRES_SECONDS,
  PRESIGNED_PUT_EXPIRES_SECONDS,
} from './types.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIXED_ID = '11111111-1111-4111-8111-111111111111';
const FIXED_NOW = new Date('2026-09-24T00:00:00.000Z');

const R2_CONFIG = {
  provider: 'cloudflare' as const,
  accountId: 'test-account',
  accessKeyId: 'test-access',
  secretAccessKey: 'test-secret',
  bucket: 'roomies-home-photos',
  s3Endpoint: 'https://test-account.r2.cloudflarestorage.com',
  region: 'auto',
};

void describe('presigned PUT', () => {
  void it('expires in 5 minutes, signs Content-Type, and omits Content-Length and user metadata', async () => {
    const tempKey = createTempHomePhotoObjectKey(HOME_ID, () => FIXED_ID);
    const fake = createFakeHomePhotoObjectStore({ now: () => FIXED_NOW });
    const put = await fake.createPresignedPut({
      homeId: HOME_ID,
      key: tempKey,
      contentType: 'image/png',
    });
    assert.equal(put.method, 'PUT');
    assert.equal(put.expiresInSeconds, PRESIGNED_PUT_EXPIRES_SECONDS);
    assert.equal(put.expiresInSeconds, 300);
    assert.equal(put.contentType, 'image/png');
    assert.equal(
      put.expiresAt.toISOString(),
      new Date(FIXED_NOW.getTime() + 300_000).toISOString(),
    );
    assert.match(put.url, /contentType=image%2Fpng/);
    assert.doesNotMatch(put.url, /contentLength/i);
    assert.doesNotMatch(put.url, /userId|membershipId|email/i);

    const signed: {
      command: PutObjectCommand | GetObjectCommand;
      expiresIn: number;
    }[] = [];
    const store = createCloudflareR2ObjectStore({
      config: R2_CONFIG,
      client: {} as S3Client,
      now: () => FIXED_NOW,
      sign: (_client, command, options) => {
        signed.push({ command, expiresIn: options.expiresIn });
        return Promise.resolve('https://r2.example/signed-put');
      },
    });
    const cloudflare = await store.createPresignedPut({
      homeId: HOME_ID,
      key: tempKey,
      contentType: 'image/jpeg',
    });
    assert.equal(cloudflare.url, 'https://r2.example/signed-put');
    assert.equal(cloudflare.expiresInSeconds, 300);
    assert.equal(signed.length, 1);
    assert.equal(signed[0]?.expiresIn, 300);
    assert.ok(signed[0]?.command instanceof PutObjectCommand);
    const input = signed[0]?.command.input;
    assert.equal(input?.Key, tempKey);
    assert.equal(input?.ContentType, 'image/jpeg');
    assert.equal(input?.ContentLength, undefined);
    assert.equal(input?.Metadata, undefined);
    assert.equal('ChecksumAlgorithm' in (input ?? {}), false);
  });
});

void describe('presigned GET', () => {
  void it('expires in 60 seconds and requires a canonical key with webp/no-store overrides', async () => {
    const canonicalKey = createCanonicalHomePhotoObjectKey(
      HOME_ID,
      () => FIXED_ID,
    );
    const tempKey = createTempHomePhotoObjectKey(HOME_ID, () => FIXED_ID);
    const fake = createFakeHomePhotoObjectStore({ now: () => FIXED_NOW });

    await assert.rejects(
      () => fake.createPresignedGet({ homeId: HOME_ID, key: tempKey }),
      InvalidObjectStoreRequestError,
    );
    await assert.rejects(
      () =>
        fake.createPresignedGet({ homeId: OTHER_HOME_ID, key: canonicalKey }),
      InvalidObjectStoreRequestError,
    );

    const get = await fake.createPresignedGet({
      homeId: HOME_ID,
      key: canonicalKey,
    });
    assert.equal(get.method, 'GET');
    assert.equal(get.expiresInSeconds, PRESIGNED_GET_EXPIRES_SECONDS);
    assert.equal(get.expiresInSeconds, 60);
    assert.equal(get.responseContentType, HOME_PHOTO_WEBP_CONTENT_TYPE);
    assert.equal(get.responseCacheControl, HOME_PHOTO_CACHE_CONTROL);
    assert.equal(
      get.expiresAt.toISOString(),
      new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
    );

    const signed: {
      command: PutObjectCommand | GetObjectCommand;
      expiresIn: number;
    }[] = [];
    const store = createCloudflareR2ObjectStore({
      config: R2_CONFIG,
      client: {} as S3Client,
      now: () => FIXED_NOW,
      sign: (_client, command, options) => {
        signed.push({ command, expiresIn: options.expiresIn });
        return Promise.resolve('https://r2.example/signed-get');
      },
    });
    await assert.rejects(
      () => store.createPresignedGet({ homeId: HOME_ID, key: tempKey }),
      InvalidObjectStoreRequestError,
    );
    const cloudflare = await store.createPresignedGet({
      homeId: HOME_ID,
      key: canonicalKey,
    });
    assert.equal(cloudflare.url, 'https://r2.example/signed-get');
    assert.equal(signed.length, 1);
    assert.equal(signed[0]?.expiresIn, 60);
    assert.ok(signed[0]?.command instanceof GetObjectCommand);
    const input = signed[0]?.command.input;
    assert.equal(input?.Key, canonicalKey);
    assert.equal(input?.ResponseContentType, 'image/webp');
    assert.equal(input?.ResponseCacheControl, 'private, no-store');
  });
});
