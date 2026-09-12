export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Domain-agnostic outbox envelope. Callers own event type and payload
 * semantics. Processing/lease fields are never part of this input.
 */
export type OutboxEventInput<
  TType extends string,
  TPayload extends JsonObject,
> = Readonly<{
  eventId: string;
  eventType: TType;
  occurredAt: Date;
  homeId?: string;
  payload: TPayload;
}>;
