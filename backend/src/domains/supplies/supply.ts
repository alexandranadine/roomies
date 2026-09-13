export const SUPPLY_ENTRY_STATUSES = ['OPEN', 'OBTAINED', 'CANCELED'] as const;

export const SUPPLY_CLAIM_RELEASE_REASONS = [
  'CLAIMANT_RELEASED',
  'MEMBERSHIP_ENDED',
  'ENTRY_OBTAINED',
  'ENTRY_CANCELED',
] as const;

export type SupplyEntryStatus = (typeof SUPPLY_ENTRY_STATUSES)[number];
export type SupplyClaimReleaseReason =
  (typeof SUPPLY_CLAIM_RELEASE_REASONS)[number];

export type SupplyEntry = Readonly<{
  id: string;
  homeId: string;
  title: string;
  status: SupplyEntryStatus;
  createdByMembershipId: string;
  obtainedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type SupplyClaim = Readonly<{
  id: string;
  homeId: string;
  supplyEntryId: string;
  claimantMembershipId: string;
  claimedAt: Date;
  releasedAt: Date | null;
  releaseReason: SupplyClaimReleaseReason | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export function isSupplyEntryStatus(
  value: unknown,
): value is SupplyEntryStatus {
  return value === 'OPEN' || value === 'OBTAINED' || value === 'CANCELED';
}

export function isSupplyClaimReleaseReason(
  value: unknown,
): value is SupplyClaimReleaseReason {
  return (
    value === 'CLAIMANT_RELEASED' ||
    value === 'MEMBERSHIP_ENDED' ||
    value === 'ENTRY_OBTAINED' ||
    value === 'ENTRY_CANCELED'
  );
}
