import {
  createAuthRuntime as createIsolatedAuthRuntime,
  type AuthRuntime,
} from '../../../auth-runtime/src/index.js';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/index.js';
import {
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  TransactionalEmailDeliveryError,
  constrainVerificationUrl,
  createTransactionalEmailSender,
  verificationCallbackUrl,
  type TransactionalEmailSender,
} from '../email/index.js';

export type { AuthRuntime };

export type CreateAuthRuntimeCompositionOptions = Readonly<{
  emailSender?: TransactionalEmailSender;
}>;

function logDeliveryFailure(): void {
  console.error('[email] verification delivery failed');
}

/**
 * Backend-facing composition boundary for the isolated Better Auth package.
 * Product/domain modules must depend on this boundary, not Better Auth.
 */
export function createAuthRuntime(
  pool: Pool,
  config: AppConfig,
  options: CreateAuthRuntimeCompositionOptions = {},
): AuthRuntime {
  const sender = options.emailSender ?? createTransactionalEmailSender(config);
  const callbackUrl = verificationCallbackUrl(config.frontendOrigin);

  return createIsolatedAuthRuntime({
    pool,
    baseURL: config.authBaseUrl,
    trustedOrigins: config.trustedOrigins,
    secret: config.authSecret,
    secureCookies: config.secureAuthCookies,
    async sendVerificationEmail({ user, url, token }) {
      const verificationUrl = constrainVerificationUrl({
        url,
        token,
        authBaseUrl: config.authBaseUrl,
        callbackUrl,
      });
      try {
        await sender.sendVerificationEmail({
          to: user.email,
          verificationUrl,
        });
      } catch (error) {
        logDeliveryFailure();
        if (error instanceof TransactionalEmailDeliveryError) {
          throw error;
        }
        throw new TransactionalEmailDeliveryError();
      }
    },
    log(level) {
      if (level === 'error') {
        console.error('[auth] runtime error');
      } else if (level === 'warn') {
        console.warn('[auth] runtime warning');
      }
    },
  });
}

export const AUTH_EMAIL_VERIFICATION_EXPIRES_IN_SECONDS =
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS;
