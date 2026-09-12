declare const invitationTokenHashBrand: unique symbol;

export type InvitationTokenHash = Uint8Array & {
  readonly [invitationTokenHashBrand]: true;
};

export class InvalidInvitationTokenHashError extends Error {
  constructor() {
    super('Invitation token hash must be a 32-byte SHA-256 digest');
    this.name = 'InvalidInvitationTokenHashError';
  }
}

export function invitationTokenHash(value: Uint8Array): InvitationTokenHash {
  if (value.byteLength !== 32) {
    throw new InvalidInvitationTokenHashError();
  }
  return Uint8Array.from(value) as InvitationTokenHash;
}
