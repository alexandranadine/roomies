import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/api/index.js';
import {
  HOME_PHOTO_GENERIC_MESSAGE,
  HOME_PHOTO_INVALID_IMAGE_MESSAGE,
  HOME_PHOTO_UPLOAD_FAILED_MESSAGE,
  homePhotoErrorMessage,
  HomePhotoTransferError,
} from './home-photo-errors.js';
import {
  HOME_PHOTO_OVERSIZE_MESSAGE,
  HomePhotoValidationError,
} from './home-photo-validation.js';

describe('homePhotoErrorMessage', () => {
  it('maps local validation, transfer, oversize, invalid image, and 500 failures', () => {
    expect(
      homePhotoErrorMessage(new HomePhotoValidationError('unsupported')),
    ).toBe('Choose a JPEG, PNG, or WebP image.');
    expect(
      homePhotoErrorMessage(new HomePhotoValidationError('oversize')),
    ).toBe(HOME_PHOTO_OVERSIZE_MESSAGE);
    expect(homePhotoErrorMessage(new HomePhotoTransferError())).toBe(
      HOME_PHOTO_UPLOAD_FAILED_MESSAGE,
    );
    expect(
      homePhotoErrorMessage(
        new ApiError({
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          message: 'too large https://abc.r2.cloudflarestorage.com/key',
        }),
      ),
    ).toBe(HOME_PHOTO_OVERSIZE_MESSAGE);
    expect(
      homePhotoErrorMessage(
        new ApiError({
          status: 400,
          code: 'INVALID_REQUEST',
          message: 'Sharp failed on object abc/key',
        }),
      ),
    ).toBe(HOME_PHOTO_INVALID_IMAGE_MESSAGE);
    expect(
      homePhotoErrorMessage(
        new ApiError({ status: 500, message: 'AccessDenied from AWS' }),
      ),
    ).toBe(HOME_PHOTO_GENERIC_MESSAGE);
    expect(homePhotoErrorMessage(new Error('network'))).toBe(
      HOME_PHOTO_GENERIC_MESSAGE,
    );
  });
});
