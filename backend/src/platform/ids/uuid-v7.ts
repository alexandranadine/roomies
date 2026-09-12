import { randomBytes } from 'node:crypto';

/**
 * Application-generated UUIDv7. Event identity is never invented by the
 * outbox writer.
 */
export type UuidV7Generator = {
  next(): string;
};

export function createUuidV7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(nowMs);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  const randA = bytes[6] ?? 0;
  const variant = bytes[8] ?? 0;
  bytes[6] = (randA & 0x0f) | 0x70;
  bytes[8] = (variant & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const systemUuidV7: UuidV7Generator = {
  next() {
    return createUuidV7();
  },
};
