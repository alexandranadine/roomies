export const HOME_PHOTO_MAX_BYTES = 8_388_608;

export const HOME_PHOTO_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type HomePhotoContentType = (typeof HOME_PHOTO_CONTENT_TYPES)[number];

export const HOME_PHOTO_FILE_ACCEPT = HOME_PHOTO_CONTENT_TYPES.join(',');

export const HOME_PHOTO_UNSUPPORTED_MESSAGE =
  'Choose a JPEG, PNG, or WebP image.';
export const HOME_PHOTO_OVERSIZE_MESSAGE = 'Choose an image smaller than 8 MB.';

export class HomePhotoValidationError extends Error {
  readonly kind: 'unsupported' | 'oversize';

  constructor(kind: 'unsupported' | 'oversize') {
    super(
      kind === 'oversize'
        ? HOME_PHOTO_OVERSIZE_MESSAGE
        : HOME_PHOTO_UNSUPPORTED_MESSAGE,
    );
    this.name = 'HomePhotoValidationError';
    this.kind = kind;
  }
}

function isAcceptedContentType(value: string): value is HomePhotoContentType {
  return (HOME_PHOTO_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * Client-side UX checks only. The server remains authoritative.
 * Does not decode or inspect image bytes.
 */
export function validateHomePhotoFile(file: File): {
  contentType: HomePhotoContentType;
  byteSize: number;
} {
  if (!isAcceptedContentType(file.type)) {
    throw new HomePhotoValidationError('unsupported');
  }
  if (file.size > HOME_PHOTO_MAX_BYTES) {
    throw new HomePhotoValidationError('oversize');
  }
  return { contentType: file.type, byteSize: file.size };
}
