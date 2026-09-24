import { ApiError } from '../platform/api/index.js';
import {
  HOME_PHOTO_OVERSIZE_MESSAGE,
  HOME_PHOTO_UNSUPPORTED_MESSAGE,
  HomePhotoValidationError,
} from './home-photo-validation.js';

export const HOME_PHOTO_INVALID_IMAGE_MESSAGE =
  "We couldn't use that image. Try a different JPEG, PNG, or WebP.";
export const HOME_PHOTO_UPLOAD_FAILED_MESSAGE =
  "Your photo couldn't be uploaded. Try again.";
export const HOME_PHOTO_GENERIC_MESSAGE =
  'Something went wrong while updating the Home photo. Try again.';

/** Direct R2 PUT/GET failed. Message is internal — UI uses the mapped copy. */
export class HomePhotoTransferError extends Error {
  constructor() {
    super('HOME_PHOTO_TRANSFER_FAILED');
    this.name = 'HomePhotoTransferError';
  }
}

/**
 * Map photo failures to concise user-facing copy.
 * Never surfaces signed URLs, object keys, hostnames, or raw bodies.
 */
export function homePhotoErrorMessage(error: unknown): string {
  if (error instanceof HomePhotoValidationError) {
    return error.kind === 'oversize'
      ? HOME_PHOTO_OVERSIZE_MESSAGE
      : HOME_PHOTO_UNSUPPORTED_MESSAGE;
  }
  if (error instanceof HomePhotoTransferError) {
    return HOME_PHOTO_UPLOAD_FAILED_MESSAGE;
  }
  if (error instanceof ApiError) {
    if (error.status === 413 || error.code === 'PAYLOAD_TOO_LARGE') {
      return HOME_PHOTO_OVERSIZE_MESSAGE;
    }
    if (error.status === 400 || error.code === 'INVALID_REQUEST') {
      return HOME_PHOTO_INVALID_IMAGE_MESSAGE;
    }
    if (error.status >= 500) {
      return HOME_PHOTO_GENERIC_MESSAGE;
    }
  }
  return HOME_PHOTO_GENERIC_MESSAGE;
}
