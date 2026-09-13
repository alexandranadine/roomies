export const MAINTENANCE_VISIBILITIES = ['HOUSEHOLD', 'PRIVATE'] as const;
export const MAINTENANCE_STATUSES = ['OPEN', 'RESOLVED'] as const;

export type MaintenanceVisibility = (typeof MAINTENANCE_VISIBILITIES)[number];
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export type MaintenanceEntry = Readonly<{
  id: string;
  homeId: string;
  createdByMembershipId: string;
  visibility: MaintenanceVisibility;
  title: string;
  details: string | null;
  status: MaintenanceStatus;
  resolvedByMembershipId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MaintenanceAudience = Readonly<{
  homeId: string;
  maintenanceEntryId: string;
  membershipId: string;
  createdAt: Date;
}>;

export type MaintenanceListItemProjection = Readonly<{
  id: string;
  title: string;
  status: MaintenanceStatus;
  visibility: MaintenanceVisibility;
  createdByMembershipId: string;
  resolvedByMembershipId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MaintenanceDetailProjection = MaintenanceListItemProjection &
  Readonly<{
    details: string | null;
  }>;

export function isMaintenanceVisibility(
  value: unknown,
): value is MaintenanceVisibility {
  return value === 'HOUSEHOLD' || value === 'PRIVATE';
}

export function isMaintenanceStatus(
  value: unknown,
): value is MaintenanceStatus {
  return value === 'OPEN' || value === 'RESOLVED';
}

export function maintenanceStatusRank(status: MaintenanceStatus): 0 | 1 {
  return status === 'OPEN' ? 0 : 1;
}

export function isCompleteOpenLifecycle(input: {
  status: MaintenanceStatus;
  resolvedByMembershipId: string | null;
  resolvedAt: Date | null;
}): boolean {
  return (
    input.status === 'OPEN' &&
    input.resolvedByMembershipId === null &&
    input.resolvedAt === null
  );
}

export function isCompleteResolvedLifecycle(input: {
  status: MaintenanceStatus;
  resolvedByMembershipId: string | null;
  resolvedAt: Date | null;
}): boolean {
  return (
    input.status === 'RESOLVED' &&
    input.resolvedByMembershipId !== null &&
    input.resolvedAt !== null
  );
}

export function isValidMaintenanceLifecycle(input: {
  status: MaintenanceStatus;
  resolvedByMembershipId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): boolean {
  if (input.updatedAt.getTime() < input.createdAt.getTime()) {
    return false;
  }
  if (isCompleteOpenLifecycle(input)) {
    return true;
  }
  if (
    isCompleteResolvedLifecycle(input) &&
    input.resolvedAt !== null &&
    input.resolvedAt.getTime() >= input.createdAt.getTime() &&
    input.resolvedAt.getTime() <= input.updatedAt.getTime()
  ) {
    return true;
  }
  return false;
}
