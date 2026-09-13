import { z } from 'zod';
import { TASK_RECURRENCE_FREQUENCIES } from './recurrence-cursor.js';
import type { TaskDefinition } from './task-definition.js';

/**
 * Safe TaskDefinition whitelist. nextOccurrenceAt is backend execution state
 * and is not exposed. homeId is implied by the route.
 */
export const taskDefinitionDtoSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    frequency: z.enum(TASK_RECURRENCE_FREQUENCIES),
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

export type TaskDefinitionDto = z.infer<typeof taskDefinitionDtoSchema>;

export const taskDefinitionListDtoSchema = z.array(taskDefinitionDtoSchema);

export type TaskDefinitionListDto = z.infer<typeof taskDefinitionListDtoSchema>;

export function toTaskDefinitionDto(
  definition: TaskDefinition,
): TaskDefinitionDto {
  return taskDefinitionDtoSchema.parse({
    id: definition.id,
    title: definition.title,
    frequency: definition.frequency,
    weekday: definition.weekday,
    dayOfMonth: definition.dayOfMonth,
    assignedMembershipId: definition.assignedMembershipId,
    creatorMembershipId: definition.creatorMembershipId,
    nextOccurrenceDate: definition.nextOccurrenceDate,
    deactivatedAt:
      definition.deactivatedAt === null
        ? null
        : definition.deactivatedAt.toISOString(),
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
  });
}

export function toTaskDefinitionListDto(
  definitions: readonly TaskDefinition[],
): TaskDefinitionListDto {
  return taskDefinitionListDtoSchema.parse(
    definitions.map(toTaskDefinitionDto),
  );
}
