import { ApiError } from './api-error.js';

export type ApiRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute path on the API host, e.g. `/api/v1/...` or `/health`. */
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: HeadersInit;
};

export type ApiClient = {
  request: <T>(options: ApiRequestOptions) => Promise<T>;
};

type BackendErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
};

function isBackendErrorEnvelope(value: unknown): value is BackendErrorEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('error' in value)) {
    return false;
  }
  const error = value.error;
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

function joinUrl(apiOrigin: string, path: string): string {
  if (!path.startsWith('/')) {
    throw new Error('API path must start with "/"');
  }
  return `${apiOrigin}${path}`;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toApiError(status: number, body: unknown): ApiError {
  if (isBackendErrorEnvelope(body)) {
    const requestId =
      typeof body.error.requestId === 'string'
        ? body.error.requestId
        : undefined;
    return new ApiError({
      status,
      code: body.error.code,
      message: body.error.message,
      requestId,
    });
  }

  return new ApiError({
    status,
    message: 'Request failed',
  });
}

/**
 * Handwritten fetch-based API transport.
 *
 * - Uses validated `apiOrigin` (separate frontend/API hosts in production)
 * - Always sends `credentials: 'include'` for future cookie auth
 * - Maps the frozen backend error envelope onto `ApiError`
 * - Does not define feature endpoints
 */
export function createApiClient(apiOrigin: string): ApiClient {
  return {
    async request<T>(options: ApiRequestOptions): Promise<T> {
      const headers = new Headers(options.headers);
      const init: RequestInit = {
        method: options.method ?? 'GET',
        credentials: 'include',
        signal: options.signal,
        headers,
      };

      if (options.body !== undefined) {
        if (!headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
        init.body = JSON.stringify(options.body);
      }

      const response = await fetch(joinUrl(apiOrigin, options.path), init);
      const body = await parseJsonBody(response);

      if (!response.ok) {
        throw toApiError(response.status, body);
      }

      return body as T;
    },
  };
}
