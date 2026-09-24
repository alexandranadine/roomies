import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isCanonicalHomePhotoObjectKey } from '../../domains/homes/photo-object-key.js';
import { isTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import type { CloudflareObjectStoreConfig } from '../config/types.js';
import type { Clock } from '../time/clock.js';
import { systemClock } from '../time/clock.js';
import { readBoundedBytes } from './bounded-read.js';
import {
  InvalidObjectStoreRequestError,
  ObjectNotFoundError,
  ObjectStoreInfrastructureError,
  ObjectTooLargeError,
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

export type SignObjectCommand = (
  client: S3Client,
  command: PutObjectCommand | GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export type CreateCloudflareR2ObjectStoreOptions = Readonly<{
  config: CloudflareObjectStoreConfig;
  client?: S3Client;
  sign?: SignObjectCommand;
  clock?: Clock;
  now?: () => Date;
}>;

function nowFrom(options: CreateCloudflareR2ObjectStoreOptions): Date {
  if (options.now) {
    return options.now();
  }
  return (options.clock ?? systemClock).now();
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = 'name' in error ? String(error.name) : '';
  if (name === 'NoSuchKey' || name === 'NotFound') {
    return true;
  }
  const metadata = '$metadata' in error ? error.$metadata : undefined;
  if (typeof metadata === 'object' && metadata !== null) {
    const status =
      'httpStatusCode' in metadata ? metadata.httpStatusCode : undefined;
    return status === 404;
  }
  return false;
}

function logInfrastructureFailure(operation: string): void {
  console.error('[object-store] operation failed', { operation });
}

function createR2S3Client(config: CloudflareObjectStoreConfig): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    endpoint: config.s3Endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  return new S3Client(clientConfig);
}

export function createCloudflareR2ObjectStore(
  options: CreateCloudflareR2ObjectStoreOptions,
): HomePhotoObjectStore {
  const config = options.config;
  const client = options.client ?? createR2S3Client(config);
  const sign = options.sign ?? getSignedUrl;

  return {
    async createPresignedPut(input): Promise<PresignedPut> {
      if (!isTempHomePhotoObjectKey(input.key, input.homeId)) {
        throw new InvalidObjectStoreRequestError();
      }
      if (!isAcceptedHomePhotoUploadContentType(input.contentType)) {
        throw new InvalidObjectStoreRequestError();
      }
      try {
        const command = new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          ContentType: input.contentType,
        });
        const url = await sign(client, command, {
          expiresIn: PRESIGNED_PUT_EXPIRES_SECONDS,
        });
        return {
          url,
          method: 'PUT',
          expiresAt: new Date(
            nowFrom(options).getTime() + PRESIGNED_PUT_EXPIRES_SECONDS * 1000,
          ),
          expiresInSeconds: PRESIGNED_PUT_EXPIRES_SECONDS,
          contentType: input.contentType,
        };
      } catch (error) {
        if (error instanceof InvalidObjectStoreRequestError) {
          throw error;
        }
        logInfrastructureFailure('signPut');
        throw new ObjectStoreInfrastructureError();
      }
    },

    async createPresignedGet(input): Promise<PresignedGet> {
      if (!isCanonicalHomePhotoObjectKey(input.key, input.homeId)) {
        throw new InvalidObjectStoreRequestError();
      }
      try {
        const command = new GetObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          ResponseContentType: HOME_PHOTO_WEBP_CONTENT_TYPE,
          ResponseCacheControl: HOME_PHOTO_CACHE_CONTROL,
        });
        const url = await sign(client, command, {
          expiresIn: PRESIGNED_GET_EXPIRES_SECONDS,
        });
        return {
          url,
          method: 'GET',
          expiresAt: new Date(
            nowFrom(options).getTime() + PRESIGNED_GET_EXPIRES_SECONDS * 1000,
          ),
          expiresInSeconds: PRESIGNED_GET_EXPIRES_SECONDS,
          responseContentType: HOME_PHOTO_WEBP_CONTENT_TYPE,
          responseCacheControl: HOME_PHOTO_CACHE_CONTROL,
        };
      } catch (error) {
        if (error instanceof InvalidObjectStoreRequestError) {
          throw error;
        }
        logInfrastructureFailure('signGet');
        throw new ObjectStoreInfrastructureError();
      }
    },

    async getObjectBounded(input) {
      let response;
      try {
        response = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: input.key,
          }),
        );
      } catch (error) {
        if (isMissingObject(error)) {
          throw new ObjectNotFoundError();
        }
        logInfrastructureFailure('get');
        throw new ObjectStoreInfrastructureError();
      }

      if (!response.Body) {
        throw new ObjectNotFoundError();
      }

      try {
        return await readBoundedBytes(response.Body, {
          maxBytes: input.maxBytes ?? MAX_UPLOAD_BYTES,
          knownSize: response.ContentLength,
        });
      } catch (error) {
        if (
          error instanceof ObjectNotFoundError ||
          error instanceof ObjectTooLargeError ||
          error instanceof InvalidObjectStoreRequestError
        ) {
          throw error;
        }
        logInfrastructureFailure('get');
        throw new ObjectStoreInfrastructureError();
      }
    },

    async putCanonicalObject(input) {
      if (!isCanonicalHomePhotoObjectKey(input.key, input.homeId)) {
        throw new InvalidObjectStoreRequestError();
      }
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: input.key,
            Body: input.body,
            ContentType: HOME_PHOTO_WEBP_CONTENT_TYPE,
            CacheControl: HOME_PHOTO_CACHE_CONTROL,
          }),
        );
      } catch (error) {
        if (error instanceof InvalidObjectStoreRequestError) {
          throw error;
        }
        logInfrastructureFailure('put');
        throw new ObjectStoreInfrastructureError();
      }
    },

    async deleteObject(input) {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: input.key,
          }),
        );
      } catch (error) {
        if (isMissingObject(error)) {
          return;
        }
        logInfrastructureFailure('delete');
        throw new ObjectStoreInfrastructureError();
      }
    },
  };
}
