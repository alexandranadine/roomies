export const ACTIVITY_ACTION = {
  list: 'activity.list',
} as const;

export type ActivityAction =
  (typeof ACTIVITY_ACTION)[keyof typeof ACTIVITY_ACTION];
