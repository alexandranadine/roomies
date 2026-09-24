import { isCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import { isTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import type { Clock } from '../time/clock.js';
import { systemClock } from '../time/clock.js';
import { readBoundedBytes } from './bounded-read.js';
import {
  InvalidObjectStoreRequestError,
  ObjectNotFoundError,
  ObjectStoreInfrastructureError,
} from './errors.js';
import {
  HOME_PHOTO_CACHE_CONTROL,
  HOME_PHOTO_WEBP_CONTENT_TYPE,
  MAX_UPLOAD_BYTES,
  PRESIGNED_GET_EXPIRES_SECONDS,
  PRESIGNED_PUT_EXPIRES_SECONDS,
  isAcceptedHomePhotoUploadContentType,
  type HomePhotoObjectStore,
  type PresignedGet,
  type PresignedPut,
} from './types.js';

export type FakeObjectStoreOperation =
  'get' | 'put' | 'delete' | 'signPut' | 'signGet';

export type FakeHomePhotoObjectStore = HomePhotoObjectStore & {
  seed(key: string, bytes: Uint8Array, reportedContentLength?: number): void;
  getStored(key: string): Uint8Array | undefined;
  failNext(operation: FakeObjectStoreOperation): void;
  readonly calls: {
    readonly get: readonly string[];
    readonly put: readonly string[];
    readonly delete: readonly string[];
    readonly signPut: readonly string[];
    readonly signGet: readonly string[];
  };
};

type MutableStoredObject = {
  bytes: Uint8Array;
  reportedContentLength?: number;
};

export type CreateFakeHomePhotoObjectStoreOptions = Readonly<{
  clock?: Clock;
  now?: () => Date;
  beforeGet?: (key: string) => Promise<void>;
  beforePut?: (key: string) => Promise<void>;
  beforeDelete?: (key: string) => Promise<void>;
}>;

function runStoreOperation<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new ObjectStoreInfrastructureError(),
    );
  }
}

function nowFrom(
  options: CreateFakeHomePhotoObjectStoreOptions | undefined,
): Date {
  if (options?.now) {
    return options.now();
  }
  return (options?.clock ?? systemClock).now();
}

/**
 * In-process Home-photo object store for development and tests.
 * Does not emulate S3 beyond the operations this slice needs.
 */
export function createFakeHomePhotoObjectStore(
  options: CreateFakeHomePhotoObjectStoreOptions = {},
): FakeHomePhotoObjectStore {
  const objects = new Map<string, MutableStoredObject>();
  const failures = new Set<FakeObjectStoreOperation>();
  const calls = {
    get: [] as string[],
    put: [] as string[],
    delete: [] as string[],
    signPut: [] as string[],
    signGet: [] as string[],
  };

  const consumeFailure = (operation: FakeObjectStoreOperation): void => {
    if (failures.has(operation)) {
      failures.delete(operation);
      throw new ObjectStoreInfrastructureError();
    }
  };

  return {
    get calls() {
      return {
        get: [...calls.get],
        put: [...calls.put],
        delete: [...calls.delete],
        signPut: [...calls.signPut],
        signGet: [...calls.signGet],
      };
    },

    seed(key: string, bytes: Uint8Array, reportedContentLength?: number) {
      objects.set(key, {
        bytes: Uint8Array.from(bytes),
        reportedContentLength,
      });
    },

    getStored(key: string) {
      const stored = objects.get(key);
      return stored ? Uint8Array.from(stored.bytes) : undefined;
    },

    failNext(operation: FakeObjectStoreOperation) {
      failures.add(operation);
    },

    createPresignedPut(input): Promise<PresignedPut> {
      return runStoreOperation(() => {
        calls.signPut.push(input.key);
        consumeFailure('signPut');
        if (!isTempHomePhotoObjectKey(input.key, input.homeId)) {
          throw new InvalidObjectStoreRequestError();
        }
        if (!isAcceptedHomePhotoUploadContentType(input.contentType)) {
          throw new InvalidObjectStoreRequestError();
        }
        const expiresAt = new Date(
          nowFrom(options).getTime() + PRESIGNED_PUT_EXPIRES_SECONDS * 1000,
        );
        const url = new URL('https://roomies.test/object-store/put');
        url.searchParams.set('key', input.key);
        url.searchParams.set('expires', expiresAt.toISOString());
        url.searchParams.set('contentType', input.contentType);
        return {
          url: url.toString(),
          method: 'PUT' as const,
          expiresAt,
          expiresInSeconds: PRESIGNED_PUT_EXPIRES_SECONDS,
          contentType: input.contentType,
        };
      });
    },

    createPresignedGet(input): Promise<PresignedGet> {
      return runStoreOperation(() => {
        calls.signGet.push(input.key);
        consumeFailure('signGet');
        if (!isCanonicalHomePhotoObjectKey(input.key, input.homeId)) {
          throw new InvalidObjectStoreRequestError();
        }
        const expiresAt = new Date(
          nowFrom(options).getTime() + PRESIGNED_GET_EXPIRES_SECONDS * 1000,
        );
        const url = new URL('https://roomies.test/object-store/get');
        url.searchParams.set('key', input.key);
        url.searchParams.set('expires', expiresAt.toISOString());
        url.searchParams.set(
          'responseContentType',
          HOME_PHOTO_WEBP_CONTENT_TYPE,
        );
        url.searchParams.set('responseCacheControl', HOME_PHOTO_CACHE_CONTROL);
        return {
          url: url.toString(),
          method: 'GET' as const,
          expiresAt,
          expiresInSeconds: PRESIGNED_GET_EXPIRES_SECONDS,
          responseContentType: HOME_PHOTO_WEBP_CONTENT_TYPE,
          responseCacheControl: HOME_PHOTO_CACHE_CONTROL,
        };
      });
    },

    async getObjectBounded(input) {
      calls.get.push(input.key);
      if (options.beforeGet) {
        await options.beforeGet(input.key);
      }
      consumeFailure('get');
      const stored = objects.get(input.key);
      if (!stored) {
        throw new ObjectNotFoundError();
      }
      const maxBytes = input.maxBytes ?? MAX_UPLOAD_BYTES;
      return readBoundedBytes(stored.bytes, {
        maxBytes,
        knownSize: stored.reportedContentLength,
      });
    },

    async putCanonicalObject(input) {
      calls.put.push(input.key);
      if (options.beforePut) {
        await options.beforePut(input.key);
      }
      return runStoreOperation(() => {
        consumeFailure('put');
        if (!isCanonicalHomePhotoObjectKey(input.key, input.homeId)) {
          throw new InvalidObjectStoreRequestError();
        }
        objects.set(input.key, { bytes: Uint8Array.from(input.body) });
      });
    },

    async deleteObject(input) {
      calls.delete.push(input.key);
      if (options.beforeDelete) {
        await options.beforeDelete(input.key);
      }
      return runStoreOperation(() => {
        consumeFailure('delete');
        objects.delete(input.key);
      });
    },
  };
}
