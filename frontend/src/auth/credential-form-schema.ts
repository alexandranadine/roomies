import type { FieldErrors, Resolver } from 'react-hook-form';
import { z } from 'zod';

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;
/** Better Auth 1.7.4 default `minPasswordLength`. */
export const MIN_PASSWORD_LENGTH = 8;
/** Better Auth 1.7.4 default `maxPasswordLength`. */
export const MAX_PASSWORD_LENGTH = 128;
const LOCAL_PART_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FINAL_DOMAIN_LABEL_PATTERN = /^[a-z]{2,63}$/;

export type CredentialMode = 'sign-in' | 'sign-up';

function normalizeCredentialEmail(value: string): string {
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

export const credentialFormSchema = z.object({
  name: z.string(),
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
      normalizeCredentialEmail(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Enter a valid email address.',
      });
    }
  }),
  password: z.string().superRefine((value, context) => {
    if (value.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Enter a password.',
      });
      return;
    }
    if (
      value.length < MIN_PASSWORD_LENGTH ||
      value.length > MAX_PASSWORD_LENGTH
    ) {
      context.addIssue({
        code: 'custom',
        message: `Password must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`,
      });
    }
  }),
});

export type CredentialFormValues = z.infer<typeof credentialFormSchema>;

export function credentialFormResolver(
  mode: CredentialMode,
): Resolver<CredentialFormValues> {
  return async (values) => {
    const errors: FieldErrors<CredentialFormValues> = {};

    if (mode === 'sign-up') {
      const trimmedName = values.name.trim();
      if (trimmedName.length === 0) {
        errors.name = { type: 'custom', message: 'Enter your name.' };
      } else if (trimmedName.length > MAX_NAME_LENGTH) {
        errors.name = {
          type: 'custom',
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
        };
      }
    }

    const result = await credentialFormSchema.safeParseAsync(values);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (typeof field !== 'string' || field in errors) {
          continue;
        }
        errors[field as keyof CredentialFormValues] = {
          type: issue.code,
          message: issue.message,
        };
      }
      return { values: {} as Record<string, never>, errors };
    }

    if (Object.keys(errors).length > 0) {
      return { values: {} as Record<string, never>, errors };
    }

    return {
      values: {
        name: result.data.name.trim(),
        email: normalizeCredentialEmail(result.data.email),
        password: result.data.password,
      },
      errors: {},
    };
  };
}

export function toSignUpRequest(values: CredentialFormValues): {
  name: string;
  email: string;
  password: string;
} {
  return {
    name: values.name.trim(),
    email: values.email,
    password: values.password,
  };
}

export function toSignInRequest(values: CredentialFormValues): {
  email: string;
  password: string;
} {
  return {
    email: values.email,
    password: values.password,
  };
}
