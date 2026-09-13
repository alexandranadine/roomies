export const SUPPLY_ACTION = {
  create: 'supply.create',
  list: 'supply.list',
} as const;

export type SupplyAction = (typeof SUPPLY_ACTION)[keyof typeof SUPPLY_ACTION];
