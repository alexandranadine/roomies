import sharp from 'sharp';
import {
  ImagePolicyViolationError,
  ImageProcessingTimeoutError,
  ImageProcessorInfrastructureError,
  InvalidImageError,
} from './errors.js';
import {
  ACCEPTED_IMAGE_FORMATS,
  HOME_PHOTO_OUTPUT_EDGE,
  HOME_PHOTO_WEBP_ALPHA_QUALITY,
  HOME_PHOTO_WEBP_EFFORT,
  HOME_PHOTO_WEBP_QUALITY,
  IMAGE_PROCESSING_TIMEOUT_MS,
  MAX_DECODED_PIXELS,
  MAX_ENCODED_OUTPUT_BYTES,
  MAX_INPUT_EDGE,
  type HomePhotoImageProcessor,
  type ProcessedHomePhoto,
} from './types.js';

export type CreateSharpHomePhotoImageProcessorOptions = Readonly<{
  timeoutMs?: number;
  process?: (input: Uint8Array) => Promise<ProcessedHomePhoto>;
}>;

const ACCEPTED = new Set<string>(ACCEPTED_IMAGE_FORMATS);

function isAcceptedFormat(format: string | undefined): boolean {
  return format !== undefined && ACCEPTED.has(format);
}

function isAnimated(metadata: {
  pages?: number;
  delay?: readonly number[];
}): boolean {
  if (metadata.pages !== undefined && metadata.pages > 1) {
    return true;
  }
  return metadata.delay !== undefined && metadata.delay.length > 1;
}

function mapSharpFailure(error: unknown): never {
  if (
    error instanceof InvalidImageError ||
    error instanceof ImagePolicyViolationError ||
    error instanceof ImageProcessingTimeoutError ||
    error instanceof ImageProcessorInfrastructureError
  ) {
    throw error;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('timeout')) {
    throw new ImageProcessingTimeoutError();
  }
  if (message.includes('pixel limit') || message.includes('exceeds pixel')) {
    throw new ImagePolicyViolationError();
  }
  if (
    message.includes('unsupported') ||
    message.includes('invalid') ||
    message.includes('corrupt') ||
    message.includes('truncated') ||
    message.includes('bad header') ||
    message.includes('input buffer') ||
    message.includes('vipsforeign')
  ) {
    throw new InvalidImageError();
  }
  console.error('[image] processor failed');
  throw new ImageProcessorInfrastructureError();
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ImageProcessingTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    void work.catch(() => undefined);
  }
}

async function processWithSharp(
  input: Uint8Array,
): Promise<ProcessedHomePhoto> {
  const pipeline = sharp(input, {
    failOn: 'error',
    limitInputPixels: MAX_DECODED_PIXELS,
    unlimited: false,
    animated: false,
  }).timeout({ seconds: Math.ceil(IMAGE_PROCESSING_TIMEOUT_MS / 1000) });

  let metadata;
  try {
    metadata = await pipeline.metadata();
  } catch (error) {
    mapSharpFailure(error);
  }

  if (!isAcceptedFormat(metadata.format) || isAnimated(metadata)) {
    throw new InvalidImageError();
  }

  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new InvalidImageError();
  }
  if (width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE) {
    throw new ImagePolicyViolationError();
  }
  if (width * height > MAX_DECODED_PIXELS) {
    throw new ImagePolicyViolationError();
  }

  const edge = Math.min(HOME_PHOTO_OUTPUT_EDGE, width, height);

  let data: Buffer;
  let info;
  try {
    const result = await pipeline
      .rotate()
      .resize(edge, edge, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: true,
      })
      .webp({
        quality: HOME_PHOTO_WEBP_QUALITY,
        effort: HOME_PHOTO_WEBP_EFFORT,
        alphaQuality: HOME_PHOTO_WEBP_ALPHA_QUALITY,
      })
      .toBuffer({ resolveWithObject: true });
    data = result.data;
    info = result.info;
  } catch (error) {
    mapSharpFailure(error);
  }

  if (info.format !== 'webp' || info.width !== info.height) {
    throw new ImageProcessorInfrastructureError();
  }
  if (info.width > HOME_PHOTO_OUTPUT_EDGE) {
    throw new ImagePolicyViolationError();
  }
  if (data.byteLength > MAX_ENCODED_OUTPUT_BYTES) {
    throw new ImagePolicyViolationError();
  }

  return {
    bytes: data,
    width: info.width,
    height: info.height,
    contentType: 'image/webp',
  };
}

export function createSharpHomePhotoImageProcessor(
  options: CreateSharpHomePhotoImageProcessorOptions = {},
): HomePhotoImageProcessor {
  const timeoutMs = options.timeoutMs ?? IMAGE_PROCESSING_TIMEOUT_MS;
  const process = options.process ?? processWithSharp;
  return {
    process(input: Uint8Array) {
      return withTimeout(process(input), timeoutMs);
    },
  };
}
