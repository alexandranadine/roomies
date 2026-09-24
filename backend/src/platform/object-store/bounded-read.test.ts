import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { readBoundedBytes } from './bounded-read.js';
import { ObjectTooLargeError } from './errors.js';
import { MAX_UPLOAD_BYTES } from './types.js';

void describe('readBoundedBytes', () => {
  void it('accepts MAX_UPLOAD_BYTES bytes', async () => {
    const body = Buffer.alloc(MAX_UPLOAD_BYTES, 1);
    const result = await readBoundedBytes(body, { maxBytes: MAX_UPLOAD_BYTES });
    assert.equal(result.byteLength, MAX_UPLOAD_BYTES);
  });

  void it('rejects MAX_UPLOAD_BYTES + 1 bytes', async () => {
    const body = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1);
    await assert.rejects(
      () => readBoundedBytes(body, { maxBytes: MAX_UPLOAD_BYTES }),
      ObjectTooLargeError,
    );
  });

  void it('rejects reported size above the limit before buffering the body', async () => {
    let pulled = 0;
    const body = {
      *[Symbol.iterator]() {
        pulled += 1;
        yield Buffer.alloc(MAX_UPLOAD_BYTES + 1, 7);
      },
    };
    await assert.rejects(
      () =>
        readBoundedBytes(body, {
          maxBytes: MAX_UPLOAD_BYTES,
          knownSize: MAX_UPLOAD_BYTES + 1,
        }),
      ObjectTooLargeError,
    );
    assert.equal(pulled, 0);
  });

  void it('stops once max+1 bytes prove oversize when metadata is absent', async () => {
    const chunk = Buffer.alloc(1024, 2);
    let yielded = 0;
    const body = {
      *[Symbol.iterator]() {
        while (yielded < 20_000) {
          yielded += 1;
          yield chunk;
        }
      },
    };
    await assert.rejects(
      () => readBoundedBytes(body, { maxBytes: MAX_UPLOAD_BYTES }),
      ObjectTooLargeError,
    );
    assert.ok(yielded < 20_000);
    assert.ok(yielded * chunk.byteLength > MAX_UPLOAD_BYTES);
  });

  void it('does not trust a too-small reported size against a large stream', async () => {
    const chunk = Buffer.alloc(1024, 3);
    let yielded = 0;
    const body = {
      *[Symbol.iterator]() {
        while (yielded < 20_000) {
          yielded += 1;
          yield chunk;
        }
      },
    };
    await assert.rejects(
      () =>
        readBoundedBytes(body, {
          maxBytes: MAX_UPLOAD_BYTES,
          knownSize: 100,
        }),
      ObjectTooLargeError,
    );
    assert.ok(yielded * chunk.byteLength > MAX_UPLOAD_BYTES);
  });

  void it('reads a Node Readable stream up to the cap', async () => {
    const body = Readable.from([Buffer.from('abc'), Buffer.from('def')]);
    const result = await readBoundedBytes(body, { maxBytes: 16 });
    assert.equal(Buffer.from(result).toString(), 'abcdef');
  });
});
