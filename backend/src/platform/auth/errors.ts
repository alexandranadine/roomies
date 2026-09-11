/**
 * Auth-boundary errors. Messages are safe to map into HTTP diagnostics;
 * they never include SQL, tokens, cookies, or credentials.
 */
export class UnauthenticatedError extends Error {
  override readonly name = 'UnauthenticatedError';
  readonly status = 401;
  readonly code = 'UNAUTHENTICATED';

  constructor() {
    super('Authentication required');
  }
}

export class AuthInfrastructureError extends Error {
  override readonly name = 'AuthInfrastructureError';
  readonly status = 500;
  readonly code = 'INTERNAL_ERROR';

  constructor() {
    super('Authentication infrastructure failure');
  }
}
