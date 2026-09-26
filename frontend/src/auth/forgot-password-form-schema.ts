import type { FieldErrors, Resolver } from 'react-hook-form';
import { credentialFormSchema } from './credential-form-schema.js';

export const forgotPasswordFormSchema = credentialFormSchema.pick({
  email: true,
});

export type ForgotPasswordFormValues = {
  email: string;
};

export const forgotPasswordFormResolver: Resolver<ForgotPasswordFormValues> =
  async (values) => {
    const result = await forgotPasswordFormSchema.safeParseAsync(values);
    if (!result.success) {
      const errors: FieldErrors<ForgotPasswordFormValues> = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (typeof field !== 'string' || field in errors) {
          continue;
        }
        errors[field as keyof ForgotPasswordFormValues] = {
          type: issue.code,
          message: issue.message,
        };
      }
      return { values: {} as Record<string, never>, errors };
    }

    return {
      values: {
        email: result.data.email.trim().toLowerCase(),
      },
      errors: {},
    };
  };
