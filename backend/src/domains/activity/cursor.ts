import { createHash } from 'node:crypto';
import { InvalidActivityRequestError } from './errors.js';

export const ACTIVITY_LIST_CURSOR_VERSION = 1;
export const ACTIVITY_LIST_DEFAULT_LIMIT = 25;
export const ACTIVITY_LIST_MIN_LIMIT = 1;
export const ACTIVITY_LIST_MAX_LIMIT = 100;

export const ACTIVITY_LIST_QUERY_FINGERPRINT = createHash('sha256')
  .update('activity.list.v1')
  .digest('hex');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_KEYS = [
  'v',
  'occurredAt',
  'id',
  'homeId',
  'actorMembershipId',
  'queryFingerprint',
] as const;

export type ActivityListCursorPayload = Readonly<{
  v: typeof ACTIVITY_LIST_CURSOR_VERSION;
  occurredAt: string;
  id: string;
  homeId: string;
  actorMembershipId: string;
  queryFingerprint: string;
}>;

export type ActivityListCursorBinding = Readonly<{
  homeId: string;
  actorMembershipId: string;
  queryFingerprint: string;
}>;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function assertActivityListLimit(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < ACTIVITY_LIST_MIN_LIMIT ||
    limit > ACTIVITY_LIST_MAX_LIMIT
  ) {
    throw new InvalidActivityRequestError();
  }
  return limit;
}

export function encodeActivityListCursor(
  payload: ActivityListCursorPayload,
): string {
  if (
    payload.v !== ACTIVITY_LIST_CURSOR_VERSION ||
    !isIsoUtc(payload.occurredAt) ||
    !isUuid(payload.id) ||
    !isUuid(payload.homeId) ||
    !isUuid(payload.actorMembershipId) ||
    !FINGERPRINT_PATTERN.test(payload.queryFingerprint)
  ) {
    throw new InvalidActivityRequestError();
  }
  return Buffer.from(
    JSON.stringify({
      v: payload.v,
      occurredAt: payload.occurredAt,
      id: payload.id,
      homeId: payload.homeId,
      actorMembershipId: payload.actorMembershipId,
      queryFingerprint: payload.queryFingerprint,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeActivityListCursor(
  encoded: string,
): ActivityListCursorPayload {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new InvalidActivityRequestError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidActivityRequestError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidActivityRequestError();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CURSOR_KEYS.length ||
    CURSOR_KEYS.some((key) => !keys.includes(key))
  ) {
    throw new InvalidActivityRequestError();
  }
  if (
    record.v !== ACTIVITY_LIST_CURSOR_VERSION ||
    !isIsoUtc(record.occurredAt) ||
    !isUuid(record.id) ||
    !isUuid(record.homeId) ||
    !isUuid(record.actorMembershipId) ||
    typeof record.queryFingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(record.queryFingerprint)
  ) {
    throw new InvalidActivityRequestError();
  }
  return Object.freeze({
    v: ACTIVITY_LIST_CURSOR_VERSION,
    occurredAt: record.occurredAt,
    id: record.id,
    homeId: record.homeId,
    actorMembershipId: record.actorMembershipId,
    queryFingerprint: record.queryFingerprint,
  });
}

export function bindActivityListCursor(
  encoded: string,
  binding: ActivityListCursorBinding,
): ActivityListCursorPayload {
  const payload = decodeActivityListCursor(encoded);
  if (
    payload.homeId !== binding.homeId ||
    payload.actorMembershipId !== binding.actorMembershipId ||
    payload.queryFingerprint !== binding.queryFingerprint
  ) {
    throw new InvalidActivityRequestError();
  }
  return payload;
}
