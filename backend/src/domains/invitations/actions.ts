export const INVITATION_ACTION = {
  create: 'invitation.create',
} as const;

export type InvitationAction =
  (typeof INVITATION_ACTION)[keyof typeof INVITATION_ACTION];
