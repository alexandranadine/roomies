import type { FieldErrors, Resolver } from 'react-hook-form';
import { z } from 'zod';
import type { CreateMaintenanceBody } from './maintenance-api.js';

export const MAINTENANCE_TITLE_MAX_LENGTH = 120;
export const MAINTENANCE_DETAILS_MAX_LENGTH = 4000;

export const createMaintenanceFormSchema = z.object({
  title: z.string().superRefine((value, context) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Enter a title.',
      });
      return;
    }
    if (trimmed.length > MAINTENANCE_TITLE_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `Title must be ${MAINTENANCE_TITLE_MAX_LENGTH} characters or fewer.`,
      });
    }
  }),
  details: z.string().superRefine((value, context) => {
    if (value.trim().length > MAINTENANCE_DETAILS_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `Details must be ${MAINTENANCE_DETAILS_MAX_LENGTH} characters or fewer.`,
      });
    }
  }),
  visibility: z.enum(['HOUSEHOLD', 'PRIVATE']),
  /** Local form state only — never sent for HOUSEHOLD. */
  audienceMembershipIds: z.array(z.string().min(1)),
});

export type CreateMaintenanceFormValues = z.infer<
  typeof createMaintenanceFormSchema
>;

export function createMaintenanceFormResolver(): Resolver<CreateMaintenanceFormValues> {
  return async (values) => {
    const result = await createMaintenanceFormSchema.safeParseAsync(values);
    if (result.success) {
      return { values: result.data, errors: {} };
    }

    const errors: FieldErrors<CreateMaintenanceFormValues> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (typeof field !== 'string' || field in errors) {
        continue;
      }
      errors[field as keyof CreateMaintenanceFormValues] = {
        type: issue.code,
        message: issue.message,
      };
    }

    return { values: {}, errors };
  };
}

/**
 * Maps form values to the frozen create body.
 * HOUSEHOLD must never include audienceMembershipIds.
 * PRIVATE always includes audienceMembershipIds (possibly []).
 * Creator Membership is never injected — backend unions it.
 */
export function toCreateMaintenanceRequest(
  values: CreateMaintenanceFormValues,
): CreateMaintenanceBody {
  const title = values.title.trim();
  const detailsTrimmed = values.details.trim();
  const details = detailsTrimmed.length === 0 ? undefined : detailsTrimmed;

  if (values.visibility === 'HOUSEHOLD') {
    if (details === undefined) {
      return { visibility: 'HOUSEHOLD', title };
    }
    return { visibility: 'HOUSEHOLD', title, details };
  }

  const audienceMembershipIds = [
    ...new Set(values.audienceMembershipIds),
  ].sort();

  if (details === undefined) {
    return {
      visibility: 'PRIVATE',
      title,
      audienceMembershipIds,
    };
  }
  return {
    visibility: 'PRIVATE',
    title,
    details,
    audienceMembershipIds,
  };
}
