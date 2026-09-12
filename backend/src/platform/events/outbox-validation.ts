import { OutboxEventValidationError } from './errors.js';

/** Same generic UUID text form used elsewhere (any RFC version). */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Frozen outbox_events event_type CHECK, plus the varchar(200) column limit.
 * Rejects before PostgreSQL.
 */
export const OUTBOX_EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)*[.]v[1-9][0-9]*$/;

export const MAX_OUTBOX_EVENT_TYPE_LENGTH = 200;

export const MAX_OUTBOX_PAYLOAD_BYTES = 65_536;

export type ValidatedOutboxInsert = Readonly<{
  eventId: string;
  eventType: string;
  occurredAt: Date;
  homeId: string | null;
  payloadJson: string;
}>;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * UUIDv7: RFC text form, version nibble 7, RFC 4122 variant (8/9/a/b).
 * Path IDs remain version-agnostic in platform/http; event IDs are v7.
 */
function isUuidV7(value: string): boolean {
  if (!isUuid(value)) {
    return false;
  }
  const version = value.charAt(14);
  const variant = value.charAt(19);
  return version === '7' && /^[89ab]$/i.test(variant);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function assertJsonValue(value: unknown, seen: WeakSet<object>): void {
  if (value === undefined) {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }
  if (value === null) {
    return;
  }
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return;
  }
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new OutboxEventValidationError('INVALID_PAYLOAD');
    }
    return;
  }
  if (
    valueType === 'bigint' ||
    valueType === 'function' ||
    valueType === 'symbol'
  ) {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }
  if (valueType !== 'object') {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }

  if (value instanceof Date) {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }

  if (seen.has(value)) {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item, seen);
    }
    return;
  }

  if (!isPlainObject(value)) {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }

  for (const nested of Object.values(value)) {
    assertJsonValue(nested, seen);
  }
}

function assertPayloadObject(payload: unknown): asserts payload is object {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }
}

function serializePayload(payload: object): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }
  if (typeof serialized !== 'string' || serialized[0] !== '{') {
    throw new OutboxEventValidationError('INVALID_PAYLOAD');
  }
  return serialized;
}

export type RuntimeOutboxEventInput = Readonly<{
  eventId: unknown;
  eventType: unknown;
  occurredAt: unknown;
  homeId?: unknown;
  payload: unknown;
}>;

export function validateOutboxEventInput(
  event: RuntimeOutboxEventInput,
): ValidatedOutboxInsert {
  if (typeof event.eventId !== 'string' || !isUuidV7(event.eventId)) {
    throw new OutboxEventValidationError('INVALID_EVENT_ID');
  }

  if (
    typeof event.eventType !== 'string' ||
    event.eventType.length > MAX_OUTBOX_EVENT_TYPE_LENGTH ||
    !OUTBOX_EVENT_TYPE_PATTERN.test(event.eventType)
  ) {
    throw new OutboxEventValidationError('INVALID_EVENT_TYPE');
  }

  if (
    !(event.occurredAt instanceof Date) ||
    !Number.isFinite(event.occurredAt.getTime())
  ) {
    throw new OutboxEventValidationError('INVALID_OCCURRED_AT');
  }

  let homeId: string | null = null;
  if (event.homeId !== undefined) {
    if (typeof event.homeId !== 'string' || !isUuid(event.homeId)) {
      throw new OutboxEventValidationError('INVALID_HOME_ID');
    }
    homeId = event.homeId;
  }

  assertPayloadObject(event.payload);
  assertJsonValue(event.payload, new WeakSet());
  const payloadJson = serializePayload(event.payload);
  const byteLength = new TextEncoder().encode(payloadJson).byteLength;
  if (byteLength > MAX_OUTBOX_PAYLOAD_BYTES) {
    throw new OutboxEventValidationError('PAYLOAD_TOO_LARGE');
  }

  return Object.freeze({
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    homeId,
    payloadJson,
  });
}
