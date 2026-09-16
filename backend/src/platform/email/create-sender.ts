import type { AppConfig } from '../config/types.js';
import { createFakeTransactionalEmailSender } from './fake-sender.js';
import { createResendTransactionalEmailSender } from './resend-sender.js';
import type { TransactionalEmailSender } from './types.js';

/**
 * Build the configured transactional sender. Production never receives `fake`.
 */
export function createTransactionalEmailSender(
  config: Pick<AppConfig, 'appEnv' | 'email'>,
): TransactionalEmailSender {
  const email = config.email ?? { provider: 'fake' as const };
  if (config.appEnv === 'production' && email.provider !== 'resend') {
    throw new Error('Production mail adapter must be resend');
  }
  if (email.provider === 'resend') {
    return createResendTransactionalEmailSender({
      apiKey: email.apiKey,
      from: email.from,
    });
  }
  return createFakeTransactionalEmailSender();
}
