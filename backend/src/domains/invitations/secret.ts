import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { invitationTokenHash, type InvitationTokenHash } from './token-hash.js';

declare const invitationSecretBrand: unique symbol;

export type InvitationSecret = string & {
  readonly [invitationSecretBrand]: true;
};

export type GeneratedInvitationSecret = Readonly<{
  bytes: Uint8Array;
  encoded: InvitationSecret;
}>;

export class InvalidInvitationSecretError extends Error {
  constructor() {
    super('Invitation secret is invalid');
    this.name = 'InvalidInvitationSecretError';
  }
}

const SECRET_BYTE_LENGTH = 32;

/**
 * One-time invitation bearer secret. The raw encoded value exists only in
 * memory and response construction. Persistence receives the digest only.
 */
export function generateInvitationSecret(): GeneratedInvitationSecret {
  const bytes = new Uint8Array(randomBytes(SECRET_BYTE_LENGTH));
  return Object.freeze({
    bytes: Uint8Array.from(bytes),
    encoded: Buffer.from(bytes).toString('base64url') as InvitationSecret,
  });
}

export function hashInvitationSecretBytes(
  bytes: Uint8Array,
): InvitationTokenHash {
  const digest = createHash('sha256').update(bytes).digest();
  return invitationTokenHash(new Uint8Array(digest));
}

export function decodeInvitationSecret(encoded: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    throw new InvalidInvitationSecretError();
  }
  if (bytes.byteLength !== SECRET_BYTE_LENGTH) {
    throw new InvalidInvitationSecretError();
  }
  return new Uint8Array(bytes);
}

export function invitationTokenHashesEqual(
  left: InvitationTokenHash,
  right: InvitationTokenHash,
): boolean {
  return timingSafeEqual(left, right);
}
