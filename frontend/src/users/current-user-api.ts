import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

const currentUserSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export type CurrentUser = z.infer<typeof currentUserSchema>;

export async function getCurrentUser(
  signal?: AbortSignal,
): Promise<CurrentUser> {
  const body = await getApiClient().request<unknown>({
    path: '/api/v1/me',
    signal,
  });
  return currentUserSchema.parse(body);
}
