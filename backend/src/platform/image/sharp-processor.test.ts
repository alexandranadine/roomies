import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { configureHomePhotoImageProcessor } from './configure.js';
import {
  ImagePolicyViolationError,
  ImageProcessingTimeoutError,
  InvalidImageError,
} from './errors.js';
import { createSharpHomePhotoImageProcessor } from './sharp-processor.js';
import { MAX_INPUT_EDGE } from './types.js';

configureHomePhotoImageProcessor();

const processor = createSharpHomePhotoImageProcessor();

async function solidJpeg(
  width: number,
  height: number,
  background = 'red',
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background },
  })
    .jpeg()
    .toBuffer();
}

async function assertProcessedSquareWebp(
  input: Buffer,
  expectedEdge?: number,
): Promise<void> {
  const result = await processor.process(input);
  assert.equal(result.contentType, 'image/webp');
  assert.equal(result.width, result.height);
  assert.ok(result.width <= 1024);
  if (expectedEdge !== undefined) {
    assert.equal(result.width, expectedEdge);
  }
  const meta = await sharp(result.bytes).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, result.width);
  assert.equal(meta.height, result.height);
  assert.equal(meta.exif, undefined);
  assert.equal(meta.icc, undefined);
  assert.equal(meta.xmp, undefined);
  assert.equal(meta.iptc, undefined);
}

void describe('Sharp Home photo processor', () => {
  void it('accepts JPEG, PNG, and WebP and emits square WebP', async () => {
    const jpeg = await solidJpeg(64, 48);
    const png = await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 4,
        background: { r: 0, g: 255, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const webp = await sharp({
      create: { width: 64, height: 48, channels: 3, background: 'blue' },
    })
      .webp()
      .toBuffer();
    await assertProcessedSquareWebp(jpeg, 48);
    await assertProcessedSquareWebp(png, 48);
    await assertProcessedSquareWebp(webp, 48);
  });

  void it('downscales a large image to 1024×1024', async () => {
    const input = await solidJpeg(3000, 2000, 'green');
    await assertProcessedSquareWebp(input, 1024);
  });

  void it('keeps a source smaller than 1024 square without enlarging', async () => {
    const square = await solidJpeg(50, 50);
    await assertProcessedSquareWebp(square, 50);
    const rect = await solidJpeg(400, 200);
    await assertProcessedSquareWebp(rect, 200);
  });

  void it('applies EXIF orientation with rotate()', async () => {
    const landscape = await sharp({
      create: { width: 40, height: 20, channels: 3, background: 'red' },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 20,
              height: 20,
              channels: 3,
              background: { r: 0, g: 0, b: 255 },
            },
          })
            .png()
            .toBuffer(),
          left: 20,
          top: 0,
        },
      ])
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await processor.process(landscape);
    assert.equal(result.width, result.height);
    assert.equal(result.width, 20);
    const { data, info } = await sharp(result.bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const top = data[2];
    const bottom = data[(info.height - 1) * info.width * info.channels + 2];
    assert.notEqual(top, bottom);
  });

  void it('strips EXIF, GPS, ICC, and XMP', async () => {
    const input = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'red' },
    })
      .jpeg()
      .withMetadata({
        orientation: 1,
        exif: {
          IFD0: { Copyright: 'secret-owner' },
          IFD3: { GPSLatitudeRef: 'N' },
        },
      })
      .toBuffer();
    const before = await sharp(input).metadata();
    assert.ok(before.exif);
    await assertProcessedSquareWebp(input, 32);
  });

  void it('rejects malformed, truncated, and spoofed bytes', async () => {
    await assert.rejects(
      () => processor.process(Buffer.from('not-an-image')),
      InvalidImageError,
    );
    await assert.rejects(
      () => processor.process(Buffer.from([0xff, 0xd8, 0xff, 0x00])),
      InvalidImageError,
    );
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await assert.rejects(
      () => processor.process(jpegHeader),
      InvalidImageError,
    );
  });

  void it('rejects GIF, animated WebP, HEIC/HEIF, and SVG without rasterizing', async () => {
    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: 'red' },
    })
      .gif()
      .toBuffer();
    await assert.rejects(() => processor.process(gif), InvalidImageError);

    const frame1 = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const frame2 = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const animatedWebp = await sharp([frame1, frame2], {
      join: { animated: true },
    })
      .webp({ loop: 0, delay: 100 })
      .toBuffer();
    await assert.rejects(
      () => processor.process(animatedWebp),
      InvalidImageError,
    );

    const heic = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      0x00, 0x00, 0x00, 0x00, 0x68, 0x65, 0x69, 0x63, 0x6d, 0x69, 0x66, 0x31,
    ]);
    await assert.rejects(() => processor.process(heic), InvalidImageError);

    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>',
    );
    await assert.rejects(() => processor.process(svg), InvalidImageError);

    const tiff = await sharp({
      create: { width: 8, height: 8, channels: 3, background: 'red' },
    })
      .tiff()
      .toBuffer();
    await assert.rejects(() => processor.process(tiff), InvalidImageError);

    await assert.rejects(
      () => processor.process(Buffer.from('%PDF-1.4')),
      InvalidImageError,
    );
  });

  void it('rejects an input edge above 6000', async () => {
    const input = await solidJpeg(MAX_INPUT_EDGE + 1, 10);
    await assert.rejects(
      () => processor.process(input),
      ImagePolicyViolationError,
    );
  });

  void it(
    'rejects decoded pixels above 25,000,000',
    { timeout: 60_000 },
    async () => {
      const input = await sharp({
        create: { width: 5001, height: 5001, channels: 3, background: 'red' },
      })
        .jpeg({ quality: 40 })
        .toBuffer();
      await assert.rejects(
        () => processor.process(input),
        ImagePolicyViolationError,
      );
    },
  );

  void it('rejects encoded output above 512 KiB', async () => {
    const noise = randomBytes(1024 * 1024 * 3);
    const input = await sharp(noise, {
      raw: { width: 1024, height: 1024, channels: 3 },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    await assert.rejects(
      () => processor.process(input),
      ImagePolicyViolationError,
    );
  });

  void it('returns a typed timeout failure', async () => {
    const hanging = createSharpHomePhotoImageProcessor({
      timeoutMs: 20,
      process: () =>
        new Promise(() => {
          /* never resolves */
        }),
    });
    await assert.rejects(
      () => hanging.process(Buffer.from('ignored')),
      ImageProcessingTimeoutError,
    );
  });
});
