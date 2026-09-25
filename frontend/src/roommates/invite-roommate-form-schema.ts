import type { FieldErrors, Resolver } from 'react-hook-form';
import { z } from 'zod';

const MAX_EMAIL_LENGTH = 254;
const LOCAL_PART_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FINAL_DOMAIN_LABEL_PATTERN = /^[a-z]{2,63}$/;

/**
 * Client check aligned with the backend invitation email contract.
 * The server remains authoritative.
 */
export function normalizeInvitationEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    !/^[\x21-\x7e]+$/.test(normalized)
  ) {
    throw new Error('unsupported');
  }

  const separator = normalized.indexOf('@');
  if (separator <= 0 || separator !== normalized.lastIndexOf('@')) {
    throw new Error('unsupported');
  }

  const localPart = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  if (
    !LOCAL_PART_PATTERN.test(localPart) ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..')
  ) {
    throw new Error('unsupported');
  }

  const labels = domain.split('.');
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label)) ||
    !FINAL_DOMAIN_LABEL_PATTERN.test(labels.at(-1) ?? '')
  ) {
    throw new Error('unsupported');
  }

  return normalized;
}

export const inviteRoommateFormSchema = z.object({
  email: z.string().superRefine((value, context) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Enter an email address.',
      });
      return;
    }
    try {
      normalizeInvitationEmail(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Enter a valid email address.',
      });
    }
  }),
});

export type InviteRoommateFormValues = z.infer<typeof inviteRoommateFormSchema>;

export function inviteRoommateFormResolver(): Resolver<InviteRoommateFormValues> {
  return async (values) => {
    const result = await inviteRoommateFormSchema.safeParseAsync(values);
    if (result.success) {
      return { values: result.data, errors: {} };
    }

    const errors: FieldErrors<InviteRoommateFormValues> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (typeof field !== 'string' || field in errors) {
        continue;
      }
      errors[field as keyof InviteRoommateFormValues] = {
        type: issue.code,
        message: issue.message,
      };
    }

    return { values: {}, errors };
  };
}
