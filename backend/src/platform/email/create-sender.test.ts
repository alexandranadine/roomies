import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTransactionalEmailSender } from './create-sender.js';
import { createFakeTransactionalEmailSender } from './fake-sender.js';

void describe('createTransactionalEmailSender', () => {
  void it('uses the fake adapter in local and test configs', async () => {
    const sender = createTransactionalEmailSender({
      appEnv: 'test',
      email: { provider: 'fake' },
    });
    assert.equal('sent' in sender, true);
    await sender.sendVerificationEmail({
      to: 'roommate@example.test',
      verificationUrl:
        'http://localhost:3000/api/auth/verify-email?token=tok&callbackURL=http%3A%2F%2Flocalhost%3A5173%2Fverify-email',
    });
    const fake = sender as ReturnType<
      typeof createFakeTransactionalEmailSender
    >;
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]?.to, 'roommate@example.test');
  });

  void it('selects the Resend adapter for staging/production config', () => {
    const sender = createTransactionalEmailSender({
      appEnv: 'staging',
      email: {
        provider: 'resend',
        apiKey: 're_test_config_only_not_a_real_secret_key',
        from: 'Roomies <noreply@roomies.example>',
      },
    });
    assert.equal('sent' in sender, false);
  });

  void it('fails closed in production when the adapter is not resend', () => {
    assert.throws(
      () =>
        createTransactionalEmailSender({
          appEnv: 'production',
          email: { provider: 'fake' },
        }),
      /must be resend/,
    );
  });
});
