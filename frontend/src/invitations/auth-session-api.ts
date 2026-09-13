import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

const authSessionSchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1),
        email: z.string().min(1),
        emailVerified: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough()
  .nullable();

export type InvitationAuthSession = z.infer<typeof authSessionSchema>;

export const invitationAuthSessionQueryKey = ['auth-session'] as const;

/**
 * Better Auth session projection for presentation only. Acceptance never
 * trusts it; the backend rereads canonical identity inside the transaction.
 */
export async function getInvitationAuthSession(
  signal?: AbortSignal,
): Promise<InvitationAuthSession> {
  const body = await getApiClient().request<unknown>({
    path: '/api/auth/get-session',
    signal,
  });
  return authSessionSchema.parse(body);
}
