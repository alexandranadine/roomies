export const MAX_DECODED_PIXELS = 25_000_000;
export const MAX_INPUT_EDGE = 6000;
export const MAX_ENCODED_OUTPUT_BYTES = 512 * 1024;
export const HOME_PHOTO_OUTPUT_EDGE = 1024;
export const HOME_PHOTO_WEBP_QUALITY = 80;
export const HOME_PHOTO_WEBP_EFFORT = 4;
export const HOME_PHOTO_WEBP_ALPHA_QUALITY = 80;
export const IMAGE_PROCESSING_TIMEOUT_MS = 5_000;
export const ACCEPTED_IMAGE_FORMATS = ['jpeg', 'png', 'webp'] as const;

export type AcceptedImageFormat = (typeof ACCEPTED_IMAGE_FORMATS)[number];

export type ProcessedHomePhoto = Readonly<{
  bytes: Uint8Array;
  width: number;
  height: number;
  contentType: 'image/webp';
}>;

export type HomePhotoImageProcessor = {
  process(input: Uint8Array): Promise<ProcessedHomePhoto>;
};
