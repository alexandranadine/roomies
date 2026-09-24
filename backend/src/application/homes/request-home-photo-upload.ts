import { randomUUID } from 'node:crypto';
import { decideHomeChangePhoto } from '../../domains/homes/policies.js';
import { createTempHomePhotoObjectKey } from '../../domains/homes/temp-photo-object-key.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type {
  AcceptedHomePhotoUploadContentType,
  HomePhotoObjectStore,
} from '../../platform/object-store/index.js';

export type RequestHomePhotoUploadInput = Readonly<{
  actor: ActiveHomeActor;
  homeId: string;
  contentType: AcceptedHomePhotoUploadContentType;
}>;

export type RequestHomePhotoUploadResult = Readonly<{
  uploadId: string;
  uploadUrl: string;
  expiresAt: Date;
  contentType: AcceptedHomePhotoUploadContentType;
}>;

export type RequestHomePhotoUploadDependencies = Readonly<{
  objectStore: Pick<HomePhotoObjectStore, 'createPresignedPut'>;
  generateUploadId?: () => string;
}>;

/**
 * Authorize a Home-photo upload intent and mint a short-lived presigned PUT.
 * Declared size limits are enforced by the HTTP adapter; the signer does not
 * enforce the 8 MiB application cap.
 */
export function createRequestHomePhotoUpload(
  deps: RequestHomePhotoUploadDependencies,
): (input: RequestHomePhotoUploadInput) => Promise<RequestHomePhotoUploadResult> {
  const generateUploadId = deps.generateUploadId ?? randomUUID;
  return async (input) => {
    const decision = decideHomeChangePhoto({
      actor: input.actor,
      targetHomeId: input.homeId,
    });
    if (!decision.allowed) {
      throw new ConcealedNotFoundError();
    }

    const uploadId = generateUploadId().toLowerCase();
    const key = createTempHomePhotoObjectKey(input.homeId, () => uploadId);
    const signed = await deps.objectStore.createPresignedPut({
      homeId: input.homeId,
      key,
      contentType: input.contentType,
    });

    return Object.freeze({
      uploadId,
      uploadUrl: signed.url,
      expiresAt: signed.expiresAt,
      contentType: signed.contentType,
    });
  };
}
