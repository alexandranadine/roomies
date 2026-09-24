export const MAX_UPLOAD_BYTES = 8_388_608;
export const PRESIGNED_PUT_EXPIRES_SECONDS = 300;
export const PRESIGNED_GET_EXPIRES_SECONDS = 60;
export const HOME_PHOTO_WEBP_CONTENT_TYPE = 'image/webp';
export const HOME_PHOTO_CACHE_CONTROL = 'private, no-store';

export const ACCEPTED_HOME_PHOTO_UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AcceptedHomePhotoUploadContentType =
  (typeof ACCEPTED_HOME_PHOTO_UPLOAD_CONTENT_TYPES)[number];

export type PresignedPut = Readonly<{
  url: string;
  method: 'PUT';
  expiresAt: Date;
  expiresInSeconds: number;
  contentType: AcceptedHomePhotoUploadContentType;
}>;

export type PresignedGet = Readonly<{
  url: string;
  method: 'GET';
  expiresAt: Date;
  expiresInSeconds: number;
  responseContentType: typeof HOME_PHOTO_WEBP_CONTENT_TYPE;
  responseCacheControl: typeof HOME_PHOTO_CACHE_CONTROL;
}>;

export type HomePhotoObjectStore = {
  createPresignedPut(input: {
    homeId: string;
    key: string;
    contentType: AcceptedHomePhotoUploadContentType;
  }): Promise<PresignedPut>;

  createPresignedGet(input: {
    homeId: string;
    key: string;
  }): Promise<PresignedGet>;

  getObjectBounded(input: {
    key: string;
    maxBytes?: number;
  }): Promise<Uint8Array>;

  putCanonicalObject(input: {
    homeId: string;
    key: string;
    body: Uint8Array;
  }): Promise<void>;

  deleteObject(input: { key: string }): Promise<void>;
};

export function isAcceptedHomePhotoUploadContentType(
  value: string,
): value is AcceptedHomePhotoUploadContentType {
  return (
    ACCEPTED_HOME_PHOTO_UPLOAD_CONTENT_TYPES as readonly string[]
  ).includes(value);
}
