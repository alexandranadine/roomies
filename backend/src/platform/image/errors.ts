/**
 * Image-processor failures. Independent of Express. Future HTTP mapping lives
 * in the application adapter, not here. Messages never include decoder or
 * libvips details.
 */
export class ImageProcessorError extends Error {
  override readonly name: string = 'ImageProcessorError';
}

export class InvalidImageError extends ImageProcessorError {
  override readonly name = 'InvalidImageError';

  constructor() {
    super('Invalid or unsupported image');
  }
}

export class ImagePolicyViolationError extends ImageProcessorError {
  override readonly name = 'ImagePolicyViolationError';

  constructor() {
    super('Image violates processing policy');
  }
}

export class ImageProcessingTimeoutError extends ImageProcessorError {
  override readonly name = 'ImageProcessingTimeoutError';

  constructor() {
    super('Image processing timed out');
  }
}

export class ImageProcessorInfrastructureError extends ImageProcessorError {
  override readonly name = 'ImageProcessorInfrastructureError';

  constructor() {
    super('Image processor infrastructure failure');
  }
}
