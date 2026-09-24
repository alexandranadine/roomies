/**
 * Object-store failures. Independent of Express. Future HTTP mapping lives
 * in the application adapter, not here.
 */
export class ObjectStoreError extends Error {
  override readonly name: string = 'ObjectStoreError';
}

export class ObjectNotFoundError extends ObjectStoreError {
  override readonly name = 'ObjectNotFoundError';

  constructor() {
    super('Object not found');
  }
}

export class ObjectTooLargeError extends ObjectStoreError {
  override readonly name = 'ObjectTooLargeError';

  constructor() {
    super('Object exceeds the allowed size');
  }
}

export class ObjectStoreInfrastructureError extends ObjectStoreError {
  override readonly name = 'ObjectStoreInfrastructureError';

  constructor() {
    super('Object store infrastructure failure');
  }
}

/**
 * Caller supplied a key or content type the Home-photo store will not accept.
 * Not an HTTP error.
 */
export class InvalidObjectStoreRequestError extends ObjectStoreError {
  override readonly name = 'InvalidObjectStoreRequestError';

  constructor() {
    super('Invalid object store request');
  }
}
