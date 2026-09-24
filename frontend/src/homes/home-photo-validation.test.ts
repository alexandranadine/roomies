import { describe, expect, it } from 'vitest';
import {
  HOME_PHOTO_MAX_BYTES,
  HOME_PHOTO_OVERSIZE_MESSAGE,
  HOME_PHOTO_UNSUPPORTED_MESSAGE,
  HomePhotoValidationError,
  validateHomePhotoFile,
} from './home-photo-validation.js';

function photoFile(type: string, size: number, name = 'photo'): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('validateHomePhotoFile', () => {
  it('accepts JPEG, PNG, and WebP at the maximum size', () => {
    expect(
      validateHomePhotoFile(photoFile('image/jpeg', HOME_PHOTO_MAX_BYTES)),
    ).toEqual({
      contentType: 'image/jpeg',
      byteSize: HOME_PHOTO_MAX_BYTES,
    });
    expect(
      validateHomePhotoFile(photoFile('image/png', HOME_PHOTO_MAX_BYTES)),
    ).toEqual({
      contentType: 'image/png',
      byteSize: HOME_PHOTO_MAX_BYTES,
    });
    expect(
      validateHomePhotoFile(photoFile('image/webp', HOME_PHOTO_MAX_BYTES)),
    ).toEqual({
      contentType: 'image/webp',
      byteSize: HOME_PHOTO_MAX_BYTES,
    });
  });

  it('rejects HEIC, GIF, empty, and unknown MIME types', () => {
    for (const type of [
      'image/heic',
      'image/gif',
      '',
      'application/octet-stream',
    ]) {
      expect(() => validateHomePhotoFile(photoFile(type, 16))).toThrow(
        HomePhotoValidationError,
      );
      try {
        validateHomePhotoFile(photoFile(type, 16));
      } catch (error) {
        expect(error).toMatchObject({
          kind: 'unsupported',
          message: HOME_PHOTO_UNSUPPORTED_MESSAGE,
        });
      }
    }
  });

  it('rejects one byte over the 8 MB limit', () => {
    expect(() =>
      validateHomePhotoFile(photoFile('image/jpeg', HOME_PHOTO_MAX_BYTES + 1)),
    ).toThrow(HomePhotoValidationError);
    try {
      validateHomePhotoFile(photoFile('image/jpeg', HOME_PHOTO_MAX_BYTES + 1));
    } catch (error) {
      expect(error).toMatchObject({
        kind: 'oversize',
        message: HOME_PHOTO_OVERSIZE_MESSAGE,
      });
    }
  });
});
