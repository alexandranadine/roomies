import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Card, TextField } from '../components/ui/index.js';
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
};

export function CredentialForm({
  defaultEmail = '',
  defaultMode = 'sign-in',
}: CredentialFormProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<CredentialMode>(defaultMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [signedUp, setSignedUp] = useState(false);
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
  });

  const submitCredentials = handleSubmit(async (values) => {
    authMutation.reset();
    setSignedUp(false);
    try {
      await authMutation.mutateAsync(values);
      if (mode === 'sign-up') {
        setSignedUp(true);
      }
      await queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
      await queryClient.invalidateQueries({
        queryKey: invitationAuthSessionQueryKey,
      });
    } catch (error) {
      setError('root', {
        type: 'server',
        message: credentialAuthErrorMessage(error, mode),
      });
    }
  });

  const isPending = authMutation.isPending;

  return (
    <Card padding="lg" className="flex max-w-lg flex-col gap-4">
      <div className="flex gap-2" role="group" aria-label="Account action">
        <Button
          type="button"
          variant={mode === 'sign-in' ? 'primary' : 'secondary'}
          disabled={isPending}
          onClick={() => {
            setMode('sign-in');
            setSignedUp(false);
            authMutation.reset();
            reset({ name: '', email: defaultEmail, password: '' });
          }}
        >
          Use existing account
        </Button>
        <Button
          type="button"
          variant={mode === 'sign-up' ? 'primary' : 'secondary'}
          disabled={isPending}
          onClick={() => {
            setMode('sign-up');
            setSignedUp(false);
            authMutation.reset();
            reset({ name: '', email: defaultEmail, password: '' });
          }}
        >
          New account
        </Button>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => void submitCredentials(event)}
        noValidate
      >
        {mode === 'sign-up' ? (
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
          autoComplete={
            mode === 'sign-up' ? 'new-password' : 'current-password'
          }
          required
          disabled={isPending}
          invalid={Boolean(errors.password)}
          errorText={errors.password?.message}
          {...register('password')}
        />
        {errors.root?.message ? (
          <Alert variant="danger" title="Couldn’t continue">
            {errors.root.message}
          </Alert>
        ) : null}
        {signedUp ? (
          <Alert variant="success" title={VERIFICATION_EMAIL_SENT_TITLE}>
            {VERIFICATION_EMAIL_SENT}
          </Alert>
        ) : null}
        <Button type="submit" loading={isPending}>
          {mode === 'sign-up' ? 'Create account' : 'Sign in'}
        </Button>
      </form>
    </Card>
  );
}
