import { createHash } from 'node:crypto';
import { InvalidNotificationRequestError } from './errors.js';

export const NOTIFICATION_LIST_CURSOR_VERSION = 1;
export const NOTIFICATION_LIST_DEFAULT_LIMIT = 25;
export const NOTIFICATION_LIST_MIN_LIMIT = 1;
export const NOTIFICATION_LIST_MAX_LIMIT = 100;

export const NOTIFICATION_LIST_QUERY_FINGERPRINT = createHash('sha256')
  .update('notifications.list.v1')
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
  'userId',
  'queryFingerprint',
] as const;

export type NotificationListCursorPayload = Readonly<{
  v: typeof NOTIFICATION_LIST_CURSOR_VERSION;
  occurredAt: string;
  id: string;
  userId: string;
  queryFingerprint: string;
}>;

export type NotificationListCursorBinding = Readonly<{
  userId: string;
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

export function assertNotificationListLimit(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < NOTIFICATION_LIST_MIN_LIMIT ||
    limit > NOTIFICATION_LIST_MAX_LIMIT
  ) {
    throw new InvalidNotificationRequestError();
  }
  return limit;
}

export function encodeNotificationListCursor(
  payload: NotificationListCursorPayload,
): string {
  if (
    payload.v !== NOTIFICATION_LIST_CURSOR_VERSION ||
    !isIsoUtc(payload.occurredAt) ||
    !isUuid(payload.id) ||
    !isUuid(payload.userId) ||
    !FINGERPRINT_PATTERN.test(payload.queryFingerprint)
  ) {
    throw new InvalidNotificationRequestError();
  }
  return Buffer.from(
    JSON.stringify({
      v: payload.v,
      occurredAt: payload.occurredAt,
      id: payload.id,
      userId: payload.userId,
      queryFingerprint: payload.queryFingerprint,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeNotificationListCursor(
  encoded: string,
): NotificationListCursorPayload {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new InvalidNotificationRequestError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidNotificationRequestError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidNotificationRequestError();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CURSOR_KEYS.length ||
    CURSOR_KEYS.some((key) => !keys.includes(key))
  ) {
    throw new InvalidNotificationRequestError();
  }
  if (
    record.v !== NOTIFICATION_LIST_CURSOR_VERSION ||
    !isIsoUtc(record.occurredAt) ||
    !isUuid(record.id) ||
    !isUuid(record.userId) ||
    typeof record.queryFingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(record.queryFingerprint)
  ) {
    throw new InvalidNotificationRequestError();
  }
  return Object.freeze({
    v: NOTIFICATION_LIST_CURSOR_VERSION,
    occurredAt: record.occurredAt,
    id: record.id,
    userId: record.userId,
    queryFingerprint: record.queryFingerprint,
  });
}

export function bindNotificationListCursor(
  encoded: string,
  binding: NotificationListCursorBinding,
): NotificationListCursorPayload {
  const payload = decodeNotificationListCursor(encoded);
  if (
    payload.userId !== binding.userId ||
    payload.queryFingerprint !== binding.queryFingerprint
  ) {
    throw new InvalidNotificationRequestError();
  }
  return payload;
}
