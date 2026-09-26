import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { Alert, Button, Card, TextField } from '../components/ui/index.js';
import { DocumentTitle } from '../components/document-title.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { invitationAuthSessionQueryKey } from '../invitations/auth-session-api.js';
import { signInWithEmail, signUpWithEmail } from './auth-credential-api.js';
import { credentialAuthErrorMessage } from './auth-credential-errors.js';
import {
  credentialFormResolver,
  toSignInRequest,
  toSignUpRequest,
  type CredentialFormValues,
  type CredentialMode,
} from './credential-form-schema.js';
import {
  VERIFICATION_EMAIL_SENT,
  VERIFICATION_EMAIL_SENT_TITLE,
} from './verification-copy.js';

export type CredentialFormProps = {
  defaultEmail?: string;
  defaultMode?: CredentialMode;
  headingLevel?: 'h1' | 'h2';
  signInHelper?: string;
  signUpHelper?: string;
};

function modeSwitchClassName() {
  return 'font-semibold text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm';
}

export function CredentialForm({
  defaultEmail = '',
  defaultMode = 'sign-in',
  headingLevel = 'h1',
  signInHelper = 'Sign in to your home.',
  signUpHelper = 'Start a home or join one you’ve been invited to.',
}: CredentialFormProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<CredentialMode>(defaultMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [signedUp, setSignedUp] = useState(false);
  const formErrorRef = useRef<HTMLDivElement>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
    setError,
    reset,
  } = useForm<CredentialFormValues>({
    resolver: (values, context, options) =>
      credentialFormResolver(modeRef.current)(values, context, options),
    defaultValues: {
      name: '',
      email: defaultEmail,
      password: '',
    },
  });

  const authMutation = useMutation({
    mutationFn: async (values: CredentialFormValues) => {
      if (mode === 'sign-up') {
        await signUpWithEmail(toSignUpRequest(values));
        return;
      }
      await signInWithEmail(toSignInRequest(values));
    },
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
      void queryClient.invalidateQueries({
        queryKey: invitationAuthSessionQueryKey,
      });
    },
  });

  const submitCredentials = handleSubmit(async (values) => {
    authMutation.reset();
    setSignedUp(false);
    try {
      await authMutation.mutateAsync(values);
      if (mode === 'sign-up') {
        setSignedUp(true);
      }
    } catch (error) {
      setError('root', {
        type: 'server',
        message: credentialAuthErrorMessage(error, mode),
      });
    }
  });

  useEffect(() => {
    if (errors.root?.message) {
      formErrorRef.current?.focus();
    }
  }, [errors.root?.message]);

  const isPending = authMutation.isPending;
  const isSignUp = mode === 'sign-up';

  const switchMode = (next: CredentialMode) => {
    setMode(next);
    setSignedUp(false);
    authMutation.reset();
    reset({ name: '', email: defaultEmail, password: '' });
  };

  return (
    <Card padding="lg" className="flex w-full flex-col gap-5">
      {headingLevel === 'h1' ? (
        <DocumentTitle
          title={isSignUp ? 'Create account · Roomies' : 'Sign in · Roomies'}
        />
      ) : null}
      <div className="flex flex-col gap-1">
        {headingLevel === 'h1' ? (
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            {isSignUp ? 'Create your account' : 'Welcome back'}
          </h1>
        ) : (
          <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
            {isSignUp ? 'Create your account' : 'Welcome back'}
          </h2>
        )}
        <p className="text-sm break-words text-text-secondary">
          {isSignUp ? signUpHelper : signInHelper}
        </p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => void submitCredentials(event)}
        noValidate
      >
        {isSignUp ? (
          <TextField
            label="Name"
            autoComplete="name"
            required
            disabled={isPending}
            invalid={Boolean(errors.name)}
            errorText={errors.name?.message}
            {...register('name')}
          />
        ) : null}
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
        <TextField
          label="Password"
          type="password"
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
          required
          disabled={isPending}
          invalid={Boolean(errors.password)}
          errorText={errors.password?.message}
          {...register('password')}
        />
        {isSignUp ? null : (
          <p className="-mt-1 text-right text-sm">
            <Link to="/forgot-password" className={modeSwitchClassName()}>
              Forgot password?
            </Link>
          </p>
        )}
        {errors.root?.message ? (
          <div ref={formErrorRef} tabIndex={-1} className="outline-none">
            <Alert variant="danger" title="Couldn’t continue">
              {errors.root.message}
            </Alert>
          </div>
        ) : null}
        {signedUp ? (
          <Alert variant="success" title={VERIFICATION_EMAIL_SENT_TITLE}>
            {VERIFICATION_EMAIL_SENT}
          </Alert>
        ) : null}
        <Button type="submit" className="w-full" loading={isPending}>
          {isSignUp ? 'Create account' : 'Sign in'}
        </Button>
      </form>
      <p className="text-center text-sm text-text-secondary">
        {isSignUp ? (
          <>
            Already have an account?{' '}
            <button
              type="button"
              className={modeSwitchClassName()}
              disabled={isPending}
              onClick={() => {
                switchMode('sign-in');
              }}
            >
              Sign in
            </button>
          </>
        ) : (
          <>
            New to Roomies?{' '}
            <button
              type="button"
              className={modeSwitchClassName()}
              disabled={isPending}
              onClick={() => {
                switchMode('sign-up');
              }}
            >
              Create an account
            </button>
          </>
        )}
      </p>
    </Card>
  );
}
