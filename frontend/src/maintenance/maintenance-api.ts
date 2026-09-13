import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

export const maintenanceStatusSchema = z.enum(['OPEN', 'RESOLVED']);
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>;

export const maintenanceVisibilitySchema = z.enum(['HOUSEHOLD', 'PRIVATE']);
export type MaintenanceVisibility = z.infer<typeof maintenanceVisibilitySchema>;

/**
 * List item wire DTO. Does not include `details` — list responses never carry it.
 */
export const maintenanceListItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: maintenanceStatusSchema,
    visibility: maintenanceVisibilitySchema,
    createdByMembershipId: z.string().min(1),
    resolvedByMembershipId: z.string().min(1).nullable(),
    resolvedAt: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type MaintenanceListItem = z.infer<typeof maintenanceListItemSchema>;

export const maintenanceDetailSchema = maintenanceListItemSchema
  .extend({
    details: z.string().min(1).nullable(),
  })
  .strict();

export type MaintenanceDetail = z.infer<typeof maintenanceDetailSchema>;

export const maintenanceListPageSchema = z
  .object({
    items: z.array(maintenanceListItemSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type MaintenanceListPage = z.infer<typeof maintenanceListPageSchema>;

export type ListHomeMaintenanceParams = {
  limit?: number;
  cursor?: string;
  status?: MaintenanceStatus;
  signal?: AbortSignal;
};

function buildListPath(
  homeId: string,
  params: Omit<ListHomeMaintenanceParams, 'signal'>,
): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) {
    search.set('limit', String(params.limit));
  }
  if (params.cursor !== undefined) {
    search.set('cursor', params.cursor);
  }
  if (params.status !== undefined) {
    search.set('status', params.status);
  }
  const query = search.toString();
  const base = `/api/v1/homes/${encodeURIComponent(homeId)}/maintenance`;
  return query.length > 0 ? `${base}?${query}` : base;
}

/** GET /api/v1/homes/:homeId/maintenance */
export async function listHomeMaintenance(
  homeId: string,
  params: ListHomeMaintenanceParams = {},
): Promise<MaintenanceListPage> {
  const { signal, ...query } = params;
  const body = await getApiClient().request<unknown>({
    path: buildListPath(homeId, query),
    signal,
  });
  return maintenanceListPageSchema.parse(body);
}

/** GET /api/v1/homes/:homeId/maintenance/:maintenanceEntryId */
export async function getMaintenanceEntry(
  homeId: string,
  maintenanceEntryId: string,
  signal?: AbortSignal,
): Promise<MaintenanceDetail> {
  const body = await getApiClient().request<unknown>({
    path: `/api/v1/homes/${encodeURIComponent(homeId)}/maintenance/${encodeURIComponent(maintenanceEntryId)}`,
    signal,
  });
  return maintenanceDetailSchema.parse(body);
}

export type CreateMaintenanceHouseholdBody = {
  visibility: 'HOUSEHOLD';
  title: string;
  details?: string;
};

export type CreateMaintenancePrivateBody = {
  visibility: 'PRIVATE';
  title: string;
  details?: string;
  audienceMembershipIds: string[];
};

export type CreateMaintenanceBody =
  CreateMaintenanceHouseholdBody | CreateMaintenancePrivateBody;

/** POST /api/v1/homes/:homeId/maintenance */
export async function createMaintenanceEntry(
  homeId: string,
  input: CreateMaintenanceBody,
  signal?: AbortSignal,
): Promise<MaintenanceDetail> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: `/api/v1/homes/${encodeURIComponent(homeId)}/maintenance`,
    body: input,
    signal,
  });
  return maintenanceDetailSchema.parse(body);
}

/** POST /api/v1/homes/:homeId/maintenance/:maintenanceEntryId/resolve */
export async function resolveMaintenanceEntry(
  homeId: string,
  maintenanceEntryId: string,
  signal?: AbortSignal,
): Promise<MaintenanceDetail> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: `/api/v1/homes/${encodeURIComponent(homeId)}/maintenance/${encodeURIComponent(maintenanceEntryId)}/resolve`,
    body: {},
    signal,
  });
  return maintenanceDetailSchema.parse(body);
}
