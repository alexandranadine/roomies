import { getApiClient } from '../platform/api/index.js';

/**
 * DELETE /api/v1/account — 204 with empty body.
 * Confirmation phrase is validated by the server; callers must only send
 * the exact frozen value when the UI gate allows submit.
 */
export async function deleteAccount(
  confirmation: 'DELETE',
  signal?: AbortSignal,
): Promise<void> {
  await getApiClient().request<void>({
    method: 'DELETE',
    path: '/api/v1/account',
    body: { confirmation },
    signal,
  });
}
