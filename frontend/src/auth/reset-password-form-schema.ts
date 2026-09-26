import type { FieldErrors, Resolver } from 'react-hook-form';
import { z } from 'zod';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from './credential-form-schema.js';

export type ResetPasswordFormValues = {
  password: string;
  confirmPassword: string;
};

const passwordSchema = z.string().superRefine((value, context) => {
  if (value.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'Enter a password.',
    });
    return;
  }
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    context.addIssue({
      code: 'custom',
      message: `Password must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`,
    });
  }
});

export const resetPasswordFormSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .superRefine((value, context) => {
    if (value.confirmPassword.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['confirmPassword'],
        message: 'Confirm your new password.',
      });
      return;
    }
    if (value.confirmPassword !== value.password) {
      context.addIssue({
        code: 'custom',
        path: ['confirmPassword'],
        message: 'Passwords do not match.',
      });
    }
  });

export const resetPasswordFormResolver: Resolver<ResetPasswordFormValues> =
  async (values) => {
    const result = await resetPasswordFormSchema.safeParseAsync(values);
    if (!result.success) {
      const errors: FieldErrors<ResetPasswordFormValues> = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (typeof field !== 'string' || field in errors) {
          continue;
        }
        errors[field as keyof ResetPasswordFormValues] = {
          type: issue.code,
          message: issue.message,
        };
      }
      return { values: {} as Record<string, never>, errors };
    }

    return {
      values: result.data,
      errors: {},
    };
  };
