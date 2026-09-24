import sharp from 'sharp';

const SHARP_CACHE = { memory: 32, files: 0, items: 20 } as const;

/**
 * Process-wide Sharp limits for Home-photo processing.
 * Keep libvips safety limits enabled.
 */
export function configureHomePhotoImageProcessor(): void {
  sharp.concurrency(1);
  sharp.cache(SHARP_CACHE);
}
