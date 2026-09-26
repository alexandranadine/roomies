import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { TransactionalEmailDeliveryError } from './errors.js';
import { createFakeTransactionalEmailSender } from './fake-sender.js';
import { createResendTransactionalEmailSender } from './resend-sender.js';
import {
  PASSWORD_RESET_EMAIL_SUBJECT,
  passwordResetEmailText,
} from './password-reset-message.js';
import { constrainPasswordResetUrl } from './safe-password-reset-url.js';

const RESET_TOKEN = 'AbCdEfGh1234567890ResetTok';

void describe('transactional password-reset email', () => {
  void it('captures reset mail without network', async () => {
    const sender = createFakeTransactionalEmailSender();
    const resetUrl = `https://roomies.example/reset-password?token=${RESET_TOKEN}`;
    await sender.sendPasswordResetEmail({
      to: 'roommate@example.test',
      resetUrl,
    });
    assert.equal(sender.sentPasswordResets.length, 1);
    assert.equal(sender.sentPasswordResets[0]?.to, 'roommate@example.test');
    assert.equal(
      sender.sentPasswordResets[0]?.subject,
      PASSWORD_RESET_EMAIL_SUBJECT,
    );
    assert.match(sender.sentPasswordResets[0]?.text ?? '', /Roomies/);
    assert.match(
      sender.sentPasswordResets[0]?.text ?? '',
      /password reset was requested/,
    );
    assert.match(sender.sentPasswordResets[0]?.text ?? '', /expires in 1 hour/);
    assert.match(
      sender.sentPasswordResets[0]?.text ?? '',
      /If you didn't request this, you can ignore this email/,
    );
    assert.equal(sender.sentPasswordResets[0]?.resetUrl, resetUrl);
    assert.equal(sender.sentPasswordResets[0]?.text.includes('Oak Street'), false);
    assert.equal(sender.sent.length, 0);
  });

  void it('rebuilds the reset link on the trusted frontend route', () => {
    const constrained = constrainPasswordResetUrl({
      url: `https://api.roomies.example/api/auth/reset-password/${RESET_TOKEN}?callbackURL=https%3A%2F%2Fevil.example%2Fphish`,
      token: RESET_TOKEN,
      authBaseUrl: 'https://api.roomies.example',
      callbackUrl: 'https://roomies.example/reset-password',
    });
    const parsed = new URL(constrained);
    assert.equal(parsed.origin, 'https://roomies.example');
    assert.equal(parsed.pathname, '/reset-password');
    assert.equal(parsed.searchParams.get('token'), RESET_TOKEN);
    assert.equal(parsed.searchParams.get('callbackURL'), null);
  });

  void it('ignores a host-header origin on Better Auth\'s reset URL', () => {
    const constrained = constrainPasswordResetUrl({
      url: `https://evil.example/api/auth/reset-password/${RESET_TOKEN}?callbackURL=https%3A%2F%2Fevil.example%2Fphish`,
      token: RESET_TOKEN,
      authBaseUrl: 'https://api.roomies.example',
      callbackUrl: 'https://roomies.example/reset-password',
    });
    const parsed = new URL(constrained);
    assert.equal(parsed.origin, 'https://roomies.example');
    assert.equal(parsed.pathname, '/reset-password');
    assert.equal(parsed.searchParams.get('token'), RESET_TOKEN);
  });

  void it('refuses reset URLs that are not the API reset-password route', () => {
    assert.throws(
      () =>
        constrainPasswordResetUrl({
          url: `https://evil.example/reset-password?token=${RESET_TOKEN}`,
          token: RESET_TOKEN,
          authBaseUrl: 'https://api.roomies.example',
          callbackUrl: 'https://roomies.example/reset-password',
        }),
      TransactionalEmailDeliveryError,
    );
  });

  void it('refuses empty or non-alphanumeric tokens', () => {
    assert.throws(
      () =>
        constrainPasswordResetUrl({
          url: 'https://api.roomies.example/api/auth/reset-password/not.a.token',
          token: 'not.a.token',
          authBaseUrl: 'https://api.roomies.example',
          callbackUrl: 'https://roomies.example/reset-password',
        }),
      TransactionalEmailDeliveryError,
    );
    assert.throws(
      () =>
        constrainPasswordResetUrl({
          url: 'https://api.roomies.example/api/auth/reset-password/',
          token: '',
          authBaseUrl: 'https://api.roomies.example',
          callbackUrl: 'https://roomies.example/reset-password',
        }),
      TransactionalEmailDeliveryError,
    );
  });

  void it('sends Resend HTTPS JSON for reset mail', async () => {
    const apiKey = 're_live_test_only_not_real';
    const bodies: unknown[] = [];
    const sender = createResendTransactionalEmailSender({
      apiKey,
      from: 'Roomies <noreply@roomies.casa>',
      fetchImpl: (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          new Response('{"id":"provider-id"}', { status: 200 }),
        );
      },
    });

    const resetUrl = `https://roomies.casa/reset-password?token=${RESET_TOKEN}`;
    await sender.sendPasswordResetEmail({
      to: 'roommate@example.test',
      resetUrl,
    });
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0], {
      from: 'Roomies <noreply@roomies.casa>',
      to: ['roommate@example.test'],
      subject: PASSWORD_RESET_EMAIL_SUBJECT,
      text: passwordResetEmailText(resetUrl),
      html: [
        '<p>Roomies</p>',
        '<p>A password reset was requested for this email.</p>',
        `<p><a href="${resetUrl}">Reset your password</a></p>`,
        '<p>This link expires in 1 hour.</p>',
        "<p>If you didn't request this, you can ignore this email.</p>",
      ].join(''),
    });
  });

  void it('maps Resend reset failure without leaking token or provider bodies', async () => {
    const sender = createResendTransactionalEmailSender({
      apiKey: 're_live_test_only_not_real',
      from: 'noreply@roomies.example',
      fetchImpl: () =>
        Promise.resolve(
          new Response('{"message":"secret-provider-body"}', { status: 500 }),
        ),
    });
    await assert.rejects(
      sender.sendPasswordResetEmail({
        to: 'roommate@example.test',
        resetUrl: `https://roomies.example/reset-password?token=${RESET_TOKEN}`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionalEmailDeliveryError);
        assert.equal(error.message.includes('secret-provider-body'), false);
        assert.equal(error.message.includes('roommate@example.test'), false);
        assert.equal(error.message.includes(RESET_TOKEN), false);
        return true;
      },
    );
  });

  void it('keeps reset copy free of household details and current passwords', () => {
    const text = passwordResetEmailText(
      `https://roomies.example/reset-password?token=${RESET_TOKEN}`,
    );
    assert.equal(text.includes('Home'), false);
    assert.equal(text.includes('membership'), false);
    assert.equal(text.toLowerCase().includes('current password'), false);
  });

  void it('does not log reset tokens from the email or runtime composition', async () => {
    const emailSource = await readFile(
      new URL('./password-reset-message.ts', import.meta.url),
      'utf8',
    );
    const runtimeSource = await readFile(
      new URL('../auth/runtime.ts', import.meta.url),
      'utf8',
    );
    const constrainSource = await readFile(
      new URL('./safe-password-reset-url.ts', import.meta.url),
      'utf8',
    );
    for (const source of [emailSource, runtimeSource, constrainSource]) {
      assert.doesNotMatch(source, /console\.(?:log|info|debug)\(/);
      assert.doesNotMatch(source, /console\.error\([^)]*\b(?:url|token)\b/);
    }
    assert.match(runtimeSource, /sendResetPassword/);
    assert.match(runtimeSource, /constrainPasswordResetUrl/);
    assert.match(runtimeSource, /\[email\] password-reset delivery failed/);
    assert.doesNotMatch(runtimeSource, /console\.error\([^)]*token/);
    assert.doesNotMatch(
      runtimeSource,
      /sendResetPassword[\s\S]*throw new TransactionalEmailDeliveryError/,
    );
  });
});
