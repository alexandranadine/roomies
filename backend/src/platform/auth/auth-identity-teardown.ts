import {
  InvalidNormalizedEmailError,
  normalizeEmail,
  type NormalizedEmail,
} from '../../../auth-runtime/src/index.js';
import { TransactionInfrastructureError } from '../persistence/errors.js';
import type { TransactionContext } from '../persistence/transaction.js';
import type { CurrentCanonicalIdentity } from './canonical-identity-by-user.js';
import { AuthInfrastructureError } from './errors.js';

/**
 * Already-captured canonical identity for future account-lifecycle composition.
 * Capture via findCurrentCanonicalIdentityByUser before AuthIdentity is removed.
 * Not an HTTP/shared/frontend DTO.
 */
export type AuthLifecycleIdentity = Readonly<{
  userId: string;
  email: NormalizedEmail;
}>;

export type TeardownAuthIdentityInput = AuthLifecycleIdentity;

export type AuthIdentityTeardownPersistence = {
  teardownAuthForIdentity(
    tx: TransactionContext,
    identity: TeardownAuthIdentityInput,
  ): Promise<void>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Better Auth 1.7.4 core (Roomies plugins: []) stores identity-attributable
 * verification rows with value = AuthIdentity UUID (password reset and
 * disabled delete-account tokens). Identifier is a random token prefix, not
 * email. Exact identifier = captured canonical email is also deleted so any
 * leftover email-keyed row cannot follow the unique email onto a later
 * identity. Equality only — no LIKE / prefix match.
 */
export const DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL = `
DELETE FROM auth_verifications
WHERE value = $1::text
   OR identifier = $2::text
`;

/**
 * AuthIdentity is deleted last among auth rows. AuthAccount and AuthSession
 * cascade from auth_identities.id (ON DELETE CASCADE). Canonical User is
 * Restrict and is not deleted.
 */
export const DELETE_AUTH_IDENTITY_SQL = `
DELETE FROM auth_identities
WHERE id = $1::uuid
  AND email = $2
`;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireCanonicalTeardownIdentity(
  identity: TeardownAuthIdentityInput,
): AuthLifecycleIdentity {
  if (!isUuid(identity.userId) || typeof identity.email !== 'string') {
    throw new AuthInfrastructureError();
  }
  try {
    const email = normalizeEmail(identity.email);
    if (email !== identity.email) {
      throw new AuthInfrastructureError();
    }
    return Object.freeze({
      userId: identity.userId,
      email,
    });
  } catch (error) {
    if (
      error instanceof AuthInfrastructureError ||
      error instanceof InvalidNormalizedEmailError
    ) {
      throw new AuthInfrastructureError();
    }
    throw new AuthInfrastructureError();
  }
}

export function authLifecycleIdentityFromCurrent(
  identity: CurrentCanonicalIdentity,
): AuthLifecycleIdentity {
  return Object.freeze({
    userId: identity.userId,
    email: identity.email,
  });
}

/**
 * Roomies-owned auth teardown for a caller-owned transaction.
 * Does not start or finish a transaction. Does not call Better Auth HTTP or APIs.
 * Does not lock or write User, Home, Membership, Maintenance, or invitations.
 */
export function createAuthIdentityTeardownPersistence(): AuthIdentityTeardownPersistence {
  return Object.freeze({
    async teardownAuthForIdentity(tx, identity) {
      const captured = requireCanonicalTeardownIdentity(identity);

      try {
        await tx.query(DELETE_ATTRIBUTABLE_AUTH_VERIFICATIONS_SQL, [
          captured.userId,
          captured.email,
        ]);
      } catch (error) {
        if (error instanceof AuthInfrastructureError) {
          throw error;
        }
        throw new TransactionInfrastructureError();
      }

      let identityDeleted: number | null;
      try {
        const result = await tx.query(DELETE_AUTH_IDENTITY_SQL, [
          captured.userId,
          captured.email,
        ]);
        identityDeleted = result.rowCount;
      } catch (error) {
        if (error instanceof AuthInfrastructureError) {
          throw error;
        }
        throw new TransactionInfrastructureError();
      }

      if (identityDeleted !== 1) {
        throw new AuthInfrastructureError();
      }
    },
  });
}
