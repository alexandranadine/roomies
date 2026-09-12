import type { NormalizedEmail } from '../../platform/auth/index.js';
import type { InvitationTokenHash } from './token-hash.js';

export const INVITATION_REVOCATION_CAUSES = [
  'ADMIN_REVOKED',
  'HOME_ARCHIVED',
] as const;

export type InvitationRevocationCause =
  (typeof INVITATION_REVOCATION_CAUSES)[number];

export type Invitation = Readonly<{
  id: string;
  homeId: string;
  invitedEmail: NormalizedEmail;
  tokenHash: InvitationTokenHash;
  createdByMembershipId: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedMembershipId: string | null;
  revokedAt: Date | null;
  revocationCause: InvitationRevocationCause | null;
}>;

export type InvitationLifecycle =
  'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'REVOKED';

export function projectInvitationLifecycle(
  invitation: Pick<Invitation, 'acceptedAt' | 'revokedAt' | 'expiresAt'>,
  at: Date,
): InvitationLifecycle {
  if (invitation.acceptedAt !== null) {
    return 'ACCEPTED';
  }
  if (invitation.revokedAt !== null) {
    return 'REVOKED';
  }
  return at < invitation.expiresAt ? 'PENDING' : 'EXPIRED';
}
