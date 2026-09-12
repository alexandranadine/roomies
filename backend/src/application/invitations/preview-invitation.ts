import {
  createHomeRepository,
  type HomeReader,
} from '../../domains/homes/index.js';
import {
  InvalidInvitationAuthorizationError,
  parseInvitationAuthorization,
} from '../../domains/invitations/bearer.js';
import { InvitationNotAvailableError } from '../../domains/invitations/errors.js';
import { projectInvitationLifecycle } from '../../domains/invitations/invitation.js';
import {
  createInvitationRepository,
  type InvitationRepository,
} from '../../domains/invitations/repository.js';
import {
  decodeInvitationSecret,
  hashInvitationSecretBytes,
  invitationTokenHashesEqual,
  InvalidInvitationSecretError,
} from '../../domains/invitations/secret.js';
import {
  invitationTokenHash,
  type InvitationTokenHash,
} from '../../domains/invitations/token-hash.js';
import type { NormalizedEmail } from '../../platform/auth/index.js';
import type { Clock } from '../../platform/time/clock.js';
import { systemClock } from '../../platform/time/clock.js';

const UNAVAILABLE_TOKEN_HASH = invitationTokenHash(new Uint8Array(32));

export type PreviewInvitationInput = Readonly<{
  invitationId: string;
  authorization: string | undefined;
}>;

export type InvitationPreview = Readonly<{
  invitation: Readonly<{
    id: string;
    email: NormalizedEmail;
    expiresAt: Date;
    home: Readonly<{
      id: string;
      name: string;
    }>;
  }>;
}>;

export type PreviewInvitationHashesEqual = (
  left: InvitationTokenHash,
  right: InvitationTokenHash,
) => boolean;

export type PreviewInvitationDependencies = {
  invitations: Pick<InvitationRepository, 'findById'>;
  homes: Pick<HomeReader, 'findActiveHomeById'>;
  clock: Clock;
  hashesEqual: PreviewInvitationHashesEqual;
};

function digestFromAuthorization(authorization: string | undefined) {
  try {
    const encoded = parseInvitationAuthorization(authorization);
    return hashInvitationSecretBytes(decodeInvitationSecret(encoded));
  } catch (error) {
    if (
      error instanceof InvalidInvitationAuthorizationError ||
      error instanceof InvalidInvitationSecretError
    ) {
      throw new InvitationNotAvailableError();
    }
    throw error;
  }
}

export function createPreviewInvitation(
  deps: PreviewInvitationDependencies,
): (input: PreviewInvitationInput) => Promise<InvitationPreview> {
  return async (input) => {
    const supplied = digestFromAuthorization(input.authorization);
    const invitation = await deps.invitations.findById(input.invitationId);
    const stored = invitation?.tokenHash ?? UNAVAILABLE_TOKEN_HASH;
    const digestMatches = deps.hashesEqual(supplied, stored);

    if (invitation === null || !digestMatches) {
      throw new InvitationNotAvailableError();
    }

    const lifecycle = projectInvitationLifecycle(invitation, deps.clock.now());
    if (lifecycle !== 'PENDING') {
      throw new InvitationNotAvailableError();
    }

    const home = await deps.homes.findActiveHomeById(invitation.homeId);
    if (home === null) {
      throw new InvitationNotAvailableError();
    }

    return Object.freeze({
      invitation: Object.freeze({
        id: invitation.id,
        email: invitation.invitedEmail,
        expiresAt: invitation.expiresAt,
        home: Object.freeze({
          id: home.id,
          name: home.name,
        }),
      }),
    });
  };
}

export function createPreviewInvitationFromPool(
  pool: Parameters<typeof createInvitationRepository>[0],
): ReturnType<typeof createPreviewInvitation> {
  return createPreviewInvitation({
    invitations: createInvitationRepository(pool),
    homes: createHomeRepository(pool),
    clock: systemClock,
    hashesEqual: invitationTokenHashesEqual,
  });
}
