export const MEMBERSHIP_ACTION = {
  changeRole: 'membership.changeRole',
} as const;

export type MembershipAction =
  (typeof MEMBERSHIP_ACTION)[keyof typeof MEMBERSHIP_ACTION];
