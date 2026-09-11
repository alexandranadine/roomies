/**
 * Typed representation of a failed API response.
 *
 * Carries HTTP status plus optional backend error envelope fields.
 * Does not invent domain error codes — those stay on the backend.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(options: {
    status: number;
    message: string;
    code?: string | undefined;
    requestId?: string | undefined;
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
  }
}
