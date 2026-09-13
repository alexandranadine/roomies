import { createHash } from 'node:crypto';
import { InvalidMaintenanceRequestError } from './errors.js';
import { isMaintenanceStatus, type MaintenanceStatus } from './maintenance.js';

export const MAINTENANCE_LIST_CURSOR_VERSION = 1;
export const MAINTENANCE_LIST_DEFAULT_LIMIT = 25;
export const MAINTENANCE_LIST_MIN_LIMIT = 1;
export const MAINTENANCE_LIST_MAX_LIMIT = 100;

export const MAINTENANCE_LIST_QUERY_FINGERPRINT = createHash('sha256')
  .update('maintenance.list.v1')
  .digest('hex');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_KEYS = [
  'v',
  'statusRank',
  'updatedAt',
  'id',
  'homeId',
  'actorMembershipId',
  'statusFilter',
  'queryFingerprint',
] as const;

export type MaintenanceListCursorPayload = Readonly<{
  v: typeof MAINTENANCE_LIST_CURSOR_VERSION;
  statusRank: 0 | 1;
  updatedAt: string;
  id: string;
  homeId: string;
  actorMembershipId: string;
  statusFilter: MaintenanceStatus | null;
  queryFingerprint: string;
}>;

export type MaintenanceListCursorBinding = Readonly<{
  homeId: string;
  actorMembershipId: string;
  statusFilter: MaintenanceStatus | null;
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

export function assertMaintenanceListLimit(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < MAINTENANCE_LIST_MIN_LIMIT ||
    limit > MAINTENANCE_LIST_MAX_LIMIT
  ) {
    throw new InvalidMaintenanceRequestError();
  }
  return limit;
}

export function encodeMaintenanceListCursor(
  payload: MaintenanceListCursorPayload,
): string {
  if (
    payload.v !== MAINTENANCE_LIST_CURSOR_VERSION ||
    (payload.statusRank !== 0 && payload.statusRank !== 1) ||
    !isIsoUtc(payload.updatedAt) ||
    !isUuid(payload.id) ||
    !isUuid(payload.homeId) ||
    !isUuid(payload.actorMembershipId) ||
    !(
      payload.statusFilter === null || isMaintenanceStatus(payload.statusFilter)
    ) ||
    !FINGERPRINT_PATTERN.test(payload.queryFingerprint)
  ) {
    throw new InvalidMaintenanceRequestError();
  }
  return Buffer.from(
    JSON.stringify({
      v: payload.v,
      statusRank: payload.statusRank,
      updatedAt: payload.updatedAt,
      id: payload.id,
      homeId: payload.homeId,
      actorMembershipId: payload.actorMembershipId,
      statusFilter: payload.statusFilter,
      queryFingerprint: payload.queryFingerprint,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeMaintenanceListCursor(
  encoded: string,
): MaintenanceListCursorPayload {
  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new InvalidMaintenanceRequestError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidMaintenanceRequestError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidMaintenanceRequestError();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CURSOR_KEYS.length ||
    CURSOR_KEYS.some((key) => !keys.includes(key))
  ) {
    throw new InvalidMaintenanceRequestError();
  }
  if (
    record.v !== MAINTENANCE_LIST_CURSOR_VERSION ||
    (record.statusRank !== 0 && record.statusRank !== 1) ||
    !isIsoUtc(record.updatedAt) ||
    !isUuid(record.id) ||
    !isUuid(record.homeId) ||
    !isUuid(record.actorMembershipId) ||
    !(
      record.statusFilter === null || isMaintenanceStatus(record.statusFilter)
    ) ||
    typeof record.queryFingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(record.queryFingerprint)
  ) {
    throw new InvalidMaintenanceRequestError();
  }
  return Object.freeze({
    v: MAINTENANCE_LIST_CURSOR_VERSION,
    statusRank: record.statusRank,
    updatedAt: record.updatedAt,
    id: record.id,
    homeId: record.homeId,
    actorMembershipId: record.actorMembershipId,
    statusFilter: record.statusFilter,
    queryFingerprint: record.queryFingerprint,
  });
}

export function bindMaintenanceListCursor(
  encoded: string,
  binding: MaintenanceListCursorBinding,
): MaintenanceListCursorPayload {
  const payload = decodeMaintenanceListCursor(encoded);
  if (
    payload.homeId !== binding.homeId ||
    payload.actorMembershipId !== binding.actorMembershipId ||
    payload.statusFilter !== binding.statusFilter ||
    payload.queryFingerprint !== binding.queryFingerprint
  ) {
    throw new InvalidMaintenanceRequestError();
  }
  return payload;
}
