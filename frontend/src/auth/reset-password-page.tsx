import { useMutation } from '@tanstack/react-query';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  KeyIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Card, TextField } from '../components/ui/index.js';
import { AuthIconWell, AuthPageLayout } from './auth-page-layout.js';
import { resetPassword } from './password-reset-api.js';
import {
  BACK_TO_SIGN_IN,
  PASSWORD_RESET_SUCCESS_BODY,
  PASSWORD_RESET_SUCCESS_TITLE,
  REQUEST_NEW_LINK,
  RESET_LINK_INVALID_TITLE,
  RESET_PASSWORD_HELPER,
  RESET_PASSWORD_SUBMIT,
  RESET_PASSWORD_TITLE,
} from './password-reset-copy.js';
import {
  isInvalidResetLinkErrorCode,
  resetPasswordFailure,
} from './password-reset-errors.js';
import {
  resetPasswordFormResolver,
  type ResetPasswordFormValues,
} from './reset-password-form-schema.js';

type ResetView = 'form' | 'success' | 'invalid';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');
  const linkError = params.get('error');
  const hasToken = typeof token === 'string' && token.length > 0;
  const [view, setView] = useState<ResetView>(() =>
    isInvalidResetLinkErrorCode(linkError) || !hasToken ? 'invalid' : 'form',
  );
  const formErrorRef = useRef<HTMLDivElement>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm<ResetPasswordFormValues>({
    resolver: resetPasswordFormResolver,
    defaultValues: { password: '', confirmPassword: '' },
  });

  const resetMutation = useMutation({
    mutationFn: (password: string) => {
      if (!hasToken || token === null) {
        throw new Error('missing-token');
      }
      return resetPassword({ token, newPassword: password });
    },
    retry: false,
  });

  const submitPassword = handleSubmit(async (values) => {
    resetMutation.reset();
    try {
      await resetMutation.mutateAsync(values.password);
      setView('success');
      window.history.replaceState(null, '', '/reset-password');
    } catch (error) {
      const failure = resetPasswordFailure(error);
      if (failure.kind === 'invalid-token') {
        setView('invalid');
        return;
      }
      if (failure.kind === 'password') {
        setError('password', { type: 'server', message: failure.message });
        return;
      }
      setError('root', { type: 'server', message: failure.message });
    }
  });

  useEffect(() => {
    if (errors.root?.message) {
      formErrorRef.current?.focus();
    }
  }, [errors.root?.message]);

  const isPending = resetMutation.isPending;

  return (
    <AuthPageLayout title="Reset password · Roomies">
      <Card padding="lg" className="flex w-full flex-col gap-5">
        {view === 'success' ? (
          <>
            <AuthIconWell>
              <CheckCircleIcon className="size-6" />
            </AuthIconWell>
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                {PASSWORD_RESET_SUCCESS_TITLE}
              </h1>
              <p className="text-sm leading-snug text-text-secondary">
                {PASSWORD_RESET_SUCCESS_BODY}
              </p>
            </div>
            <Button
              className="w-full"
              onClick={() => {
                void navigate('/', { state: { passwordReset: true } });
              }}
            >
              {BACK_TO_SIGN_IN}
            </Button>
          </>
        ) : null}

        {view === 'invalid' ? (
          <>
            <AuthIconWell>
              <ExclamationCircleIcon className="size-6" />
            </AuthIconWell>
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                {RESET_LINK_INVALID_TITLE}
              </h1>
            </div>
            <Button
              className="w-full"
              onClick={() => {
                void navigate('/forgot-password');
              }}
            >
              {REQUEST_NEW_LINK}
            </Button>
            <p className="text-center text-sm text-text-secondary">
              <Link
                to="/"
                className="font-semibold text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
              >
                {BACK_TO_SIGN_IN}
              </Link>
            </p>
          </>
        ) : null}

        {view === 'form' ? (
          <>
            <AuthIconWell>
              <KeyIcon className="size-6" />
            </AuthIconWell>
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
                {RESET_PASSWORD_TITLE}
              </h1>
              <p className="text-sm break-words text-text-secondary">
                {RESET_PASSWORD_HELPER}
              </p>
            </div>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => void submitPassword(event)}
              noValidate
            >
              <TextField
                label="New password"
                type="password"
                autoComplete="new-password"
                required
                disabled={isPending}
                invalid={Boolean(errors.password)}
                errorText={errors.password?.message}
                {...register('password')}
              />
              <TextField
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                required
                disabled={isPending}
                invalid={Boolean(errors.confirmPassword)}
                errorText={errors.confirmPassword?.message}
                {...register('confirmPassword')}
              />
              {errors.root?.message ? (
                <div ref={formErrorRef} tabIndex={-1} className="outline-none">
                  <Alert variant="danger" title="Couldn’t reset password">
                    {errors.root.message}
                  </Alert>
                </div>
              ) : null}
              <Button type="submit" className="w-full" loading={isPending}>
                {RESET_PASSWORD_SUBMIT}
              </Button>
            </form>
            <p className="text-center text-sm text-text-secondary">
              <Link
                to="/"
                className="font-semibold text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
              >
                {BACK_TO_SIGN_IN}
              </Link>
            </p>
          </>
        ) : null}
      </Card>
    </AuthPageLayout>
  );
}
