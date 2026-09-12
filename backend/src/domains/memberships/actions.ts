export const MEMBERSHIP_ACTION = {
  changeRole: 'membership.changeRole',
  leave: 'membership.leave',
  remove: 'membership.remove',
} as const;

export type MembershipAction =
  (typeof MEMBERSHIP_ACTION)[keyof typeof MEMBERSHIP_ACTION];
