import {
  InvalidRequestError,
  PayloadTooLargeError,
} from '../../platform/authz/errors.js';
import {
  ImagePolicyViolationError,
  InvalidImageError,
} from '../../platform/image/errors.js';
import {
  ObjectNotFoundError,
  ObjectTooLargeError,
} from '../../platform/object-store/errors.js';

export function mapHomePhotoObjectReadError(error: unknown): never {
  if (error instanceof ObjectNotFoundError) {
    throw new InvalidRequestError();
  }
  if (error instanceof ObjectTooLargeError) {
    throw new PayloadTooLargeError();
  }
  throw error;
}

export function mapHomePhotoImageError(error: unknown): never {
  if (
    error instanceof InvalidImageError ||
    error instanceof ImagePolicyViolationError
  ) {
    throw new InvalidRequestError();
  }
  throw error;
}
