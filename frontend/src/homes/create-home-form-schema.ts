import type { FieldErrors, Resolver } from 'react-hook-form';
import { z } from 'zod';
import {
  getSupportedTimeZones,
  HOME_NAME_MAX_LENGTH,
  isSupportedTimeZone,
} from './supported-timezones.js';

export const createHomeFormSchema = z.object({
  name: z.string().superRefine((value, context) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Enter a Home name.',
      });
      return;
    }
    if (trimmed.length > HOME_NAME_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `Home name must be ${HOME_NAME_MAX_LENGTH} characters or fewer.`,
      });
    }
  }),
  timezone: z
    .string()
    .refine((value) => value.length > 0, {
      message: 'Select a timezone.',
    })
    .refine((value) => isSupportedTimeZone(value), {
      message: 'Select a valid timezone.',
    }),
});

export type CreateHomeFormValues = z.infer<typeof createHomeFormSchema>;

export function createHomeFormResolver(): Resolver<CreateHomeFormValues> {
  return async (values) => {
    const result = await createHomeFormSchema.safeParseAsync(values);
    if (result.success) {
      return { values: result.data, errors: {} };
    }

    const errors: FieldErrors<CreateHomeFormValues> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (typeof field !== 'string' || field in errors) {
        continue;
      }
      errors[field as keyof CreateHomeFormValues] = {
        type: issue.code,
        message: issue.message,
      };
    }

    return { values: {}, errors };
  };
}

export function toCreateHomeRequest(values: CreateHomeFormValues): {
  name: string;
  timezone: string;
} {
  return {
    name: values.name.trim(),
    timezone: values.timezone,
  };
}

/** Ensures datalist suggestions stay aligned with client validation. */
export function listSupportedTimeZones(): readonly string[] {
  return getSupportedTimeZones();
}
