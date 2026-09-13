export const SUPPLY_ACTION = {
  create: 'supply.create',
  list: 'supply.list',
  claim: 'supply.claim',
  releaseClaim: 'supply.release_claim',
  markObtained: 'supply.mark_obtained',
  cancel: 'supply.cancel',
} as const;

export type SupplyAction = (typeof SUPPLY_ACTION)[keyof typeof SUPPLY_ACTION];
