import { ObjectTooLargeError } from './errors.js';

export type BoundedReadOptions = Readonly<{
  maxBytes: number;
  /** Untrusted object metadata. Used only to fail fast, never as a size of record. */
  knownSize?: number;
}>;

function hasDestroy(value: object): value is { destroy: () => void } {
  return 'destroy' in value && typeof value.destroy === 'function';
}

function hasCancel(value: object): value is { cancel: () => unknown } {
  return 'cancel' in value && typeof value.cancel === 'function';
}

function stopBody(body: unknown): void {
  if (body === null || typeof body !== 'object') {
    return;
  }
  if (hasDestroy(body)) {
    body.destroy();
    return;
  }
  if (hasCancel(body)) {
    void body.cancel();
  }
}

function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<Uint8Array | Buffer | string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function isIterable(
  value: unknown,
): value is Iterable<Uint8Array | Buffer | string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Uint8Array) &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === 'function'
  );
}

/**
 * Read an object body with a hard cap. Never buffers more than `maxBytes`
 * (plus the one extra byte used to prove oversize).
 */
export async function readBoundedBytes(
  body: unknown,
  options: BoundedReadOptions,
): Promise<Uint8Array> {
  if (options.knownSize !== undefined && options.knownSize > options.maxBytes) {
    stopBody(body);
    throw new ObjectTooLargeError();
  }

  if (body instanceof Uint8Array) {
    if (body.byteLength > options.maxBytes) {
      throw new ObjectTooLargeError();
    }
    return body;
  }

  if (typeof body === 'string') {
    const encoded = Buffer.from(body);
    if (encoded.byteLength > options.maxBytes) {
      throw new ObjectTooLargeError();
    }
    return encoded;
  }

  const chunks: Buffer[] = [];
  let total = 0;

  const consumeChunk = (chunk: Uint8Array | Buffer | string): void => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > options.maxBytes) {
      stopBody(body);
      throw new ObjectTooLargeError();
    }
    chunks.push(Buffer.from(buffer));
  };

  try {
    if (isAsyncIterable(body)) {
      for await (const chunk of body) {
        consumeChunk(chunk);
      }
    } else if (isIterable(body)) {
      for (const chunk of body) {
        consumeChunk(chunk);
      }
    } else {
      stopBody(body);
      throw new Error('Unsupported object body');
    }
  } catch (error) {
    stopBody(body);
    throw error;
  }

  return Buffer.concat(chunks, total);
}
