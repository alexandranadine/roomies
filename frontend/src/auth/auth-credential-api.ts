import { getApiClient } from '../platform/api/index.js';
import { verificationCallbackUrl } from '../invitations/send-verification-email-api.js';

export async function signUpWithEmail(input: {
  name: string;
  email: string;
  password: string;
}): Promise<void> {
  await getApiClient().request({
    method: 'POST',
    path: '/api/auth/sign-up/email',
    body: {
      name: input.name,
      email: input.email,
      password: input.password,
      callbackURL: verificationCallbackUrl(),
    },
  });
}

export async function signInWithEmail(input: {
  email: string;
  password: string;
}): Promise<void> {
  await getApiClient().request({
    method: 'POST',
    path: '/api/auth/sign-in/email',
    body: {
      email: input.email,
      password: input.password,
    },
  });
}

export async function signOutSession(): Promise<void> {
  await getApiClient().request({
    method: 'POST',
    path: '/api/auth/sign-out',
  });
}
