export const INVITATION_ACTION = {
  create: 'invitation.create',
  revoke: 'invitation.revoke',
} as const;

export type InvitationAction =
  (typeof INVITATION_ACTION)[keyof typeof INVITATION_ACTION];
