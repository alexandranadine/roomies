import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';
import { homeContextSchema, type HomeContext } from './home-context-api.js';
import { HomePhotoTransferError } from './home-photo-errors.js';
import {
  HOME_PHOTO_CONTENT_TYPES,
  type HomePhotoContentType,
  validateHomePhotoFile,
} from './home-photo-validation.js';

const homePhotoUploadIntentSchema = z
  .object({
    uploadId: z.string().min(1),
    uploadUrl: z.string().min(1),
    expiresAt: z.string().min(1),
    requiredHeaders: z
      .object({
        'Content-Type': z.enum(HOME_PHOTO_CONTENT_TYPES),
      })
      .strict(),
  })
  .strict();

const homePhotoDownloadSchema = z
  .object({
    downloadUrl: z.string().min(1),
    contentType: z.literal('image/webp'),
    expiresAt: z.string().min(1),
  })
  .strict();

export type HomePhotoUploadIntent = z.infer<typeof homePhotoUploadIntentSchema>;

export async function requestHomePhotoUpload(input: {
  homeId: string;
  contentType: HomePhotoContentType;
  byteSize: number;
}): Promise<HomePhotoUploadIntent> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: `/api/v1/homes/${encodeURIComponent(input.homeId)}/photo/uploads`,
    body: {
      contentType: input.contentType,
      byteSize: input.byteSize,
    },
  });
  return homePhotoUploadIntentSchema.parse(body);
}

/**
 * Browser PUT to the signed object URL. Roomies credentials must not be sent.
 */
export async function putHomePhotoObject(input: {
  uploadUrl: string;
  contentType: HomePhotoContentType;
  body: Blob;
  signal?: AbortSignal;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(input.uploadUrl, {
      method: 'PUT',
      credentials: 'omit',
      signal: input.signal,
      headers: {
        'Content-Type': input.contentType,
      },
      body: input.body,
    });
  } catch {
    throw new HomePhotoTransferError();
  }

  if (!response.ok) {
    throw new HomePhotoTransferError();
  }
}

export async function finalizeHomePhoto(input: {
  homeId: string;
  uploadId: string;
}): Promise<HomeContext> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: `/api/v1/homes/${encodeURIComponent(input.homeId)}/photo`,
    body: { uploadId: input.uploadId },
  });
  return homeContextSchema.parse(body);
}

/**
 * Fetch the committed Home photo as a Blob.
 *
 * The signed download URL exists only as a local variable here. It is never
 * returned, stored, or attached to UI state.
 */
export async function getHomePhotoBlob(
  homeId: string,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const body = await getApiClient().request<unknown>({
    path: `/api/v1/homes/${encodeURIComponent(homeId)}/photo`,
    signal,
  });
  if (body === undefined) {
    return null;
  }

  const download = homePhotoDownloadSchema.parse(body);
  const downloadUrl = download.downloadUrl;

  let objectResponse: Response;
  try {
    objectResponse = await fetch(downloadUrl, {
      method: 'GET',
      credentials: 'omit',
      signal,
    });
  } catch {
    throw new HomePhotoTransferError();
  }

  if (!objectResponse.ok) {
    throw new HomePhotoTransferError();
  }

  try {
    return await objectResponse.blob();
  } catch {
    throw new HomePhotoTransferError();
  }
}

export async function deleteHomePhoto(homeId: string): Promise<void> {
  await getApiClient().request<unknown>({
    method: 'DELETE',
    path: `/api/v1/homes/${encodeURIComponent(homeId)}/photo`,
  });
}

export async function uploadHomePhoto(input: {
  homeId: string;
  file: File;
  signal?: AbortSignal;
}): Promise<HomeContext> {
  const { contentType, byteSize } = validateHomePhotoFile(input.file);
  const intent = await requestHomePhotoUpload({
    homeId: input.homeId,
    contentType,
    byteSize,
  });
  await putHomePhotoObject({
    uploadUrl: intent.uploadUrl,
    contentType: intent.requiredHeaders['Content-Type'],
    body: input.file,
    signal: input.signal,
  });
  return finalizeHomePhoto({
    homeId: input.homeId,
    uploadId: intent.uploadId,
  });
}
