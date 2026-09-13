import { z } from 'zod';
import type { TaskInstance } from './task.js';

/** Explicit create/list whitelist. No definition, completion, or Home internals. */
export const taskDtoSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(['OPEN', 'COMPLETED']),
    source: z.enum(['MANUAL', 'RECURRING']),
    scheduledFor: z.string().nullable(),
    assignedMembershipId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type TaskDto = z.infer<typeof taskDtoSchema>;

export const taskListDtoSchema = z.array(taskDtoSchema);

export type TaskListDto = z.infer<typeof taskListDtoSchema>;

export function toTaskDto(task: TaskInstance): TaskDto {
  return taskDtoSchema.parse({
    id: task.id,
    title: task.title,
    status: task.status,
    source: task.source,
    scheduledFor: task.scheduledFor,
    assignedMembershipId: task.assignedMembershipId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  });
}

export function toTaskListDto(tasks: readonly TaskInstance[]): TaskListDto {
  return taskListDtoSchema.parse(tasks.map(toTaskDto));
}
