import type { InvitationSecret } from './secret.js';

export class InvalidInvitationAuthorizationError extends Error {
  constructor() {
    super('Invitation authorization is invalid');
    this.name = 'InvalidInvitationAuthorizationError';
  }
}

/**
 * Strict invitation bearer credential.
 *
 * Accepts exactly `Invitation <base64url-secret>`. The scheme is case-sensitive.
 * Does not accept Bearer, multiple credentials, or extra whitespace.
 */
export function parseInvitationAuthorization(
  header: string | undefined,
): InvitationSecret {
  if (typeof header !== 'string') {
    throw new InvalidInvitationAuthorizationError();
  }
  const match = /^Invitation ([A-Za-z0-9_-]+)$/.exec(header);
  const secret = match?.[1];
  if (secret === undefined || secret.length === 0) {
    throw new InvalidInvitationAuthorizationError();
  }
  return secret as InvitationSecret;
}
