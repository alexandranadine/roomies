import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

export const taskStatusSchema = z.enum(['OPEN', 'COMPLETED']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSourceSchema = z.enum(['MANUAL', 'RECURRING']);
export type TaskSource = z.infer<typeof taskSourceSchema>;

export const taskRecurrenceFrequencySchema = z.enum([
  'DAILY',
  'WEEKLY',
  'MONTHLY',
]);
export type TaskRecurrenceFrequency = z.infer<
  typeof taskRecurrenceFrequencySchema
>;

/** TaskInstance wire DTO. Completion actor/time are not exposed. */
export const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: taskStatusSchema,
    source: taskSourceSchema,
    scheduledFor: z.string().nullable(),
    assignedMembershipId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type Task = z.infer<typeof taskSchema>;

export const taskListSchema = z.array(taskSchema);
export type TaskList = z.infer<typeof taskListSchema>;

/** Safe TaskDefinition whitelist. nextOccurrenceAt is not exposed. */
export const taskDefinitionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    frequency: taskRecurrenceFrequencySchema,
    weekday: z.number().int().nullable(),
    dayOfMonth: z.number().int().nullable(),
    assignedMembershipId: z.string().min(1).nullable(),
    creatorMembershipId: z.string().min(1),
    nextOccurrenceDate: z.string().nullable(),
    deactivatedAt: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;

export const taskDefinitionListSchema = z.array(taskDefinitionSchema);
export type TaskDefinitionList = z.infer<typeof taskDefinitionListSchema>;

export type CreateTaskBody = {
  title: string;
  assignedMembershipId: string | null;
  scheduledFor: string | null;
};

export type CreateTaskDefinitionBody = {
  title: string;
  frequency: TaskRecurrenceFrequency;
  weekday?: number | null;
  dayOfMonth?: number | null;
  assignedMembershipId: string | null;
};

function tasksPath(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/tasks`;
}

function taskDefinitionsPath(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/task-definitions`;
}

/** GET /api/v1/homes/:homeId/tasks */
export async function listHomeTasks(
  homeId: string,
  signal?: AbortSignal,
): Promise<TaskList> {
  const body = await getApiClient().request<unknown>({
    path: tasksPath(homeId),
    signal,
  });
  return taskListSchema.parse(body);
}

/** POST /api/v1/homes/:homeId/tasks */
export async function createHomeTask(
  homeId: string,
  input: CreateTaskBody,
  signal?: AbortSignal,
): Promise<Task> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: tasksPath(homeId),
    body: input,
    signal,
  });
  return taskSchema.parse(body);
}

/** POST /api/v1/homes/:homeId/tasks/:taskId/complete */
export async function completeHomeTask(
  homeId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<Task> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: `${tasksPath(homeId)}/${encodeURIComponent(taskId)}/complete`,
    body: {},
    signal,
  });
  return taskSchema.parse(body);
}

/** GET /api/v1/homes/:homeId/task-definitions */
export async function listHomeTaskDefinitions(
  homeId: string,
  signal?: AbortSignal,
): Promise<TaskDefinitionList> {
  const body = await getApiClient().request<unknown>({
    path: taskDefinitionsPath(homeId),
    signal,
  });
  return taskDefinitionListSchema.parse(body);
}

/** POST /api/v1/homes/:homeId/task-definitions */
export async function createHomeTaskDefinition(
  homeId: string,
  input: CreateTaskDefinitionBody,
  signal?: AbortSignal,
): Promise<TaskDefinition> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: taskDefinitionsPath(homeId),
    body: input,
    signal,
  });
  return taskDefinitionSchema.parse(body);
}

/** POST /api/v1/homes/:homeId/task-definitions/:taskDefinitionId/deactivate */
export async function deactivateHomeTaskDefinition(
  homeId: string,
  taskDefinitionId: string,
  signal?: AbortSignal,
): Promise<TaskDefinition> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: `${taskDefinitionsPath(homeId)}/${encodeURIComponent(taskDefinitionId)}/deactivate`,
    body: {},
    signal,
  });
  return taskDefinitionSchema.parse(body);
}
