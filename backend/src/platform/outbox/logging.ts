export type OutboxConsumerOutcome =
  'processed' | 'retry_scheduled' | 'permanently_failed';

export type OutboxConsumerLogFields = Readonly<{
  eventId?: string;
  eventType?: string;
  attemptCount?: number;
  outcome?: OutboxConsumerOutcome;
  durationMs?: number;
  errorClass?: string;
  processedCount?: number;
  failedCount?: number;
  moreWorkLikely?: boolean;
}>;

export type OutboxConsumerLogger = {
  info(event: string, fields?: OutboxConsumerLogFields): void;
  error(event: string, fields?: OutboxConsumerLogFields): void;
};

export function createConsoleOutboxLogger(): OutboxConsumerLogger {
  return {
    info(event, fields) {
      if (fields) {
        console.info(`[outbox] ${event}`, fields);
        return;
      }
      console.info(`[outbox] ${event}`);
    },
    error(event, fields) {
      if (fields) {
        console.error(`[outbox] ${event}`, fields);
        return;
      }
      console.error(`[outbox] ${event}`);
    },
  };
}

export function outboxErrorClassOf(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return 'Error';
}
