import type { FieldErrors, Resolver } from 'react-hook-form';
import { z } from 'zod';
import type { CreateTaskBody, CreateTaskDefinitionBody } from './tasks-api.js';

export const TASK_REPEAT_OPTIONS = [
  'ONCE',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
] as const;

export type TaskRepeatOption = (typeof TASK_REPEAT_OPTIONS)[number];

const HOME_LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const createTaskFormSchema = z
  .object({
    title: z.string(),
    assignedMembershipId: z.string(),
    scheduledFor: z.string(),
    repeat: z.enum(TASK_REPEAT_OPTIONS),
    weekday: z.number().int(),
    dayOfMonth: z.number().int(),
  })
  .superRefine((values, context) => {
    const trimmed = values.title.trim();
    if (trimmed.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['title'],
        message: 'Enter a title.',
      });
    }

    if (values.repeat === 'ONCE' && values.scheduledFor.trim().length > 0) {
      if (!HOME_LOCAL_DATE_PATTERN.test(values.scheduledFor)) {
        context.addIssue({
          code: 'custom',
          path: ['scheduledFor'],
          message: 'Enter a valid due date.',
        });
      }
    }

    if (values.repeat === 'WEEKLY') {
      if (values.weekday < 1 || values.weekday > 7) {
        context.addIssue({
          code: 'custom',
          path: ['weekday'],
          message: 'Choose a weekday.',
        });
      }
    }

    if (values.repeat === 'MONTHLY') {
      if (values.dayOfMonth < 1 || values.dayOfMonth > 31) {
        context.addIssue({
          code: 'custom',
          path: ['dayOfMonth'],
          message: 'Choose a day of the month.',
        });
      }
    }
  });

export type CreateTaskFormValues = z.infer<typeof createTaskFormSchema>;

export function createTaskFormResolver(): Resolver<CreateTaskFormValues> {
  return async (values) => {
    const result = await createTaskFormSchema.safeParseAsync(values);
    if (result.success) {
      return { values: result.data, errors: {} };
    }

    const errors: FieldErrors<CreateTaskFormValues> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (typeof field !== 'string' || field in errors) {
        continue;
      }
      errors[field as keyof CreateTaskFormValues] = {
        type: issue.code,
        message: issue.message,
      };
    }

    return { values: {}, errors };
  };
}

export type CreateTaskRequest =
  | { kind: 'task'; body: CreateTaskBody }
  | { kind: 'definition'; body: CreateTaskDefinitionBody };

function assignedMembershipIdFromForm(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Maps form values to the frozen create bodies.
 * Recurring chores use TaskDefinition; one-time chores use TaskInstance.
 */
export function toCreateTaskRequest(
  values: CreateTaskFormValues,
): CreateTaskRequest {
  const title = values.title.trim();
  const assignedMembershipId = assignedMembershipIdFromForm(
    values.assignedMembershipId,
  );

  if (values.repeat === 'ONCE') {
    const scheduledFor =
      values.scheduledFor.trim().length === 0 ? null : values.scheduledFor;
    return {
      kind: 'task',
      body: {
        title,
        assignedMembershipId,
        scheduledFor,
      },
    };
  }

  if (values.repeat === 'DAILY') {
    return {
      kind: 'definition',
      body: {
        title,
        frequency: 'DAILY',
        assignedMembershipId,
      },
    };
  }

  if (values.repeat === 'WEEKLY') {
    return {
      kind: 'definition',
      body: {
        title,
        frequency: 'WEEKLY',
        weekday: values.weekday,
        assignedMembershipId,
      },
    };
  }

  return {
    kind: 'definition',
    body: {
      title,
      frequency: 'MONTHLY',
      dayOfMonth: values.dayOfMonth,
      assignedMembershipId,
    },
  };
}
