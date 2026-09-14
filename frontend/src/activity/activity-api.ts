import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

export const activityActorDisplaySchema = z
  .object({
    membershipId: z.string().min(1),
    name: z.string().min(1).nullable(),
  })
  .strict();

export type ActivityActorDisplay = z.infer<typeof activityActorDisplaySchema>;

export const activitySourceEntityTypeSchema = z.enum([
  'MEMBERSHIP',
  'TASK',
  'SUPPLY',
  'MAINTENANCE',
]);

export type ActivitySourceEntityType = z.infer<
  typeof activitySourceEntityTypeSchema
>;

/**
 * Recipient-safe Activity list item. Visibility, audience, userId, and
 * recipients are intentionally absent from this DTO.
 */
export const activityListItemSchema = z
  .object({
    id: z.string().min(1),
    eventType: z.string().min(1),
    sourceEntityType: activitySourceEntityTypeSchema,
    sourceEntityId: z.string().min(1),
    occurredAt: z.string().min(1),
    actor: activityActorDisplaySchema.nullable(),
    sourceTitle: z.string().min(1).nullable(),
    subject: activityActorDisplaySchema.nullable(),
  })
  .strict();

export type ActivityListItem = z.infer<typeof activityListItemSchema>;

export const activityListPageSchema = z
  .object({
    items: z.array(activityListItemSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type ActivityListPage = z.infer<typeof activityListPageSchema>;

export type ListHomeActivityParams = {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
};

function buildListPath(
  homeId: string,
  params: Omit<ListHomeActivityParams, 'signal'>,
): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) {
    search.set('limit', String(params.limit));
  }
  if (params.cursor !== undefined) {
    search.set('cursor', params.cursor);
  }
  const query = search.toString();
  const base = `/api/v1/homes/${encodeURIComponent(homeId)}/activity`;
  return query.length > 0 ? `${base}?${query}` : base;
}

/** GET /api/v1/homes/:homeId/activity */
export async function listHomeActivity(
  homeId: string,
  params: ListHomeActivityParams = {},
): Promise<ActivityListPage> {
  const { signal, ...query } = params;
  const body = await getApiClient().request<unknown>({
    path: buildListPath(homeId, query),
    signal,
  });
  return activityListPageSchema.parse(body);
}
