import type { OutboxEventInput } from '../../platform/events/outbox-types.js';

export const TASK_COMPLETED_V1 = 'task.completed.v1';

export type TaskCompletedV1Payload = Readonly<{
  taskInstanceId: string;
}>;

export function createTaskCompletedV1Event(
  input: Readonly<{
    eventId: string;
    occurredAt: Date;
    homeId: string;
    taskInstanceId: string;
  }>,
): OutboxEventInput<typeof TASK_COMPLETED_V1, TaskCompletedV1Payload> {
  return Object.freeze({
    eventId: input.eventId,
    eventType: TASK_COMPLETED_V1,
    occurredAt: input.occurredAt,
    homeId: input.homeId,
    payload: Object.freeze({
      taskInstanceId: input.taskInstanceId,
    }),
  });
}
