/**
 * Known authorization/HTTP-boundary errors. Messages are safe diagnostics;
 * they never include SQL, Home IDs, roles, or stack details.
 */
export class InvalidPathInputError extends Error {
  override readonly name = 'InvalidPathInputError';

  constructor() {
    super('Invalid path input');
  }
}

export class InvalidRequestError extends Error {
  override readonly name = 'InvalidRequestError';

  constructor() {
    super('Invalid request');
  }
}

export class PayloadTooLargeError extends Error {
  override readonly name = 'PayloadTooLargeError';

  constructor() {
    super('Request body too large');
  }
}

export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';

  constructor() {
    super('Forbidden');
  }
}

export class ConcealedNotFoundError extends Error {
  override readonly name = 'ConcealedNotFoundError';

  constructor() {
    super('Not found');
  }
}

export class AuthorizationIntegrityError extends Error {
  override readonly name = 'AuthorizationIntegrityError';

  constructor() {
    super('Authorization integrity failure');
  }
}
