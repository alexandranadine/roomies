export const MAINTENANCE_ACTION = {
  create: 'maintenance.create',
  list: 'maintenance.list',
  read: 'maintenance.read',
  resolve: 'maintenance.resolve',
} as const;

export type MaintenanceAction =
  (typeof MAINTENANCE_ACTION)[keyof typeof MAINTENANCE_ACTION];
