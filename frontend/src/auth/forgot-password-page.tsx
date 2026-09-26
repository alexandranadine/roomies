import { useMutation } from '@tanstack/react-query';
import { EnvelopeIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { Alert, Button, Card, TextField } from '../components/ui/index.js';
import { AuthIconWell, AuthPageLayout } from './auth-page-layout.js';
import {
  forgotPasswordFormResolver,
  type ForgotPasswordFormValues,
} from './forgot-password-form-schema.js';
import { requestPasswordReset } from './password-reset-api.js';
import {
  BACK_TO_SIGN_IN,
  CHECK_EMAIL_BODY,
  CHECK_EMAIL_TITLE,
  FORGOT_PASSWORD_HELPER,
  FORGOT_PASSWORD_TITLE,
  SEND_RESET_LINK,
} from './password-reset-copy.js';
import { forgotPasswordErrorMessage } from './password-reset-errors.js';

export function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  const formErrorRef = useRef<HTMLDivElement>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm<ForgotPasswordFormValues>({
    resolver: forgotPasswordFormResolver,
    defaultValues: { email: '' },
  });

  const requestReset = useMutation({
    mutationFn: (email: string) => requestPasswordReset(email),
    retry: false,
  });

  const submitEmail = handleSubmit(async (values) => {
    requestReset.reset();
    try {
      await requestReset.mutateAsync(values.email);
      setSubmitted(true);
    } catch (error) {
      setError('root', {
        type: 'server',
        message: forgotPasswordErrorMessage(error),
      });
    }
  });

  useEffect(() => {
    if (errors.root?.message) {
      formErrorRef.current?.focus();
    }
  }, [errors.root?.message]);

  const isPending = requestReset.isPending;

  return (
    <AuthPageLayout title="Forgot password · Roomies">
      <Card padding="lg" className="flex w-full flex-col gap-5">
        <AuthIconWell>
          <EnvelopeIcon className="size-6" />
        </AuthIconWell>
        {submitted ? (
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              {CHECK_EMAIL_TITLE}
            </h1>
            <p className="text-sm leading-snug text-text-secondary">
              {CHECK_EMAIL_BODY}
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                {FORGOT_PASSWORD_TITLE}
              </h1>
              <p className="text-sm break-words text-text-secondary">
                {FORGOT_PASSWORD_HELPER}
              </p>
            </div>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => void submitEmail(event)}
              noValidate
            >
              <TextField
                label="Email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                disabled={isPending}
                invalid={Boolean(errors.email)}
                errorText={errors.email?.message}
                {...register('email')}
              />
              {errors.root?.message ? (
                <div ref={formErrorRef} tabIndex={-1} className="outline-none">
                  <Alert variant="danger" title="Couldn’t continue">
                    {errors.root.message}
                  </Alert>
                </div>
              ) : null}
              <Button type="submit" className="w-full" loading={isPending}>
                {SEND_RESET_LINK}
              </Button>
            </form>
          </>
        )}
        <p className="text-center text-sm text-text-secondary">
          <Link
            to="/"
            className="font-semibold text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
          >
            {BACK_TO_SIGN_IN}
          </Link>
        </p>
      </Card>
    </AuthPageLayout>
  );
}
