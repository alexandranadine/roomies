import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionalEmailDeliveryError } from './errors.js';
import { createFakeTransactionalEmailSender } from './fake-sender.js';
import { createResendTransactionalEmailSender } from './resend-sender.js';
import { constrainVerificationUrl } from './safe-verification-url.js';
import {
  VERIFICATION_EMAIL_SUBJECT,
  verificationEmailText,
} from './verification-message.js';

void describe('transactional verification email', () => {
  void it('captures verification mail without network', async () => {
    const sender = createFakeTransactionalEmailSender();
    const verificationUrl =
      'http://localhost:3000/api/auth/verify-email?token=tok&callbackURL=http%3A%2F%2Flocalhost%3A5173%2Fverify-email';
    await sender.sendVerificationEmail({
      to: 'roommate@example.test',
      verificationUrl,
    });
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0]?.to, 'roommate@example.test');
    assert.equal(sender.sent[0]?.subject, VERIFICATION_EMAIL_SUBJECT);
    assert.match(sender.sent[0]?.text ?? '', /Roomies/);
    assert.match(sender.sent[0]?.text ?? '', /Verify your email address/);
    assert.match(sender.sent[0]?.text ?? '', /expires in 1 hour/);
    assert.match(
      sender.sent[0]?.text ?? '',
      /did not create or request a Roomies account/,
    );
    assert.equal(sender.sent[0]?.verificationUrl, verificationUrl);
    assert.equal(sender.sent[0]?.text.includes('Oak Street'), false);
  });

  void it('replaces callbackURL with the exact frontend return URL', () => {
    const constrained = constrainVerificationUrl({
      url: 'https://api.roomies.example/api/auth/verify-email?token=abc.def.ghi&callbackURL=https%3A%2F%2Fevil.example%2Fphish',
      token: 'abc.def.ghi',
      authBaseUrl: 'https://api.roomies.example',
      callbackUrl: 'https://roomies.example/verify-email',
    });
    const parsed = new URL(constrained);
    assert.equal(parsed.origin, 'https://api.roomies.example');
    assert.equal(parsed.pathname, '/api/auth/verify-email');
    assert.equal(parsed.searchParams.get('token'), 'abc.def.ghi');
    assert.equal(
      parsed.searchParams.get('callbackURL'),
      'https://roomies.example/verify-email',
    );
  });

  void it('rewrites a host-header origin onto the canonical API origin', () => {
    const constrained = constrainVerificationUrl({
      url: 'https://evil.example/api/auth/verify-email?token=abc.def.ghi&callbackURL=https%3A%2F%2Fevil.example%2Fphish',
      token: 'abc.def.ghi',
      authBaseUrl: 'https://api.roomies.example',
      callbackUrl: 'https://roomies.example/verify-email',
    });
    const parsed = new URL(constrained);
    assert.equal(parsed.origin, 'https://api.roomies.example');
    assert.equal(parsed.pathname, '/api/auth/verify-email');
    assert.equal(parsed.searchParams.get('token'), 'abc.def.ghi');
    assert.equal(
      parsed.searchParams.get('callbackURL'),
      'https://roomies.example/verify-email',
    );
  });

  void it('refuses verification URLs that are not the API verify-email route', () => {
    assert.throws(
      () =>
        constrainVerificationUrl({
          url: 'https://evil.example/verify-email?token=abc.def.ghi',
          token: 'abc.def.ghi',
          authBaseUrl: 'https://api.roomies.example',
          callbackUrl: 'https://roomies.example/verify-email',
        }),
      TransactionalEmailDeliveryError,
    );
  });

  void it('sends Resend HTTPS JSON without leaking the API key on failure', async () => {
    const apiKey = 're_live_test_only_not_real';
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const sender = createResendTransactionalEmailSender({
      apiKey,
      from: 'Roomies <noreply@roomies.example>',
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        calls.push({
          url,
          authorization: headers.get('authorization'),
        });
        return Promise.resolve(
          new Response('{"id":"provider-id"}', { status: 200 }),
        );
      },
    });

    await sender.sendVerificationEmail({
      to: 'roommate@example.test',
      verificationUrl:
        'https://api.roomies.example/api/auth/verify-email?token=abc&callbackURL=https%3A%2F%2Froomies.example%2Fverify-email',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.resend.com/emails');
    assert.equal(calls[0]?.authorization, `Bearer ${apiKey}`);
  });

  void it('maps Resend failure to a content-free delivery error', async () => {
    const sender = createResendTransactionalEmailSender({
      apiKey: 're_live_test_only_not_real',
      from: 'noreply@roomies.example',
      fetchImpl: () =>
        Promise.resolve(
          new Response('{"message":"secret-provider-body"}', { status: 500 }),
        ),
    });
    await assert.rejects(
      sender.sendVerificationEmail({
        to: 'roommate@example.test',
        verificationUrl:
          'https://api.roomies.example/api/auth/verify-email?token=abc',
      }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionalEmailDeliveryError);
        assert.equal(error.message.includes('secret-provider-body'), false);
        assert.equal(error.message.includes('roommate@example.test'), false);
        assert.equal(error.message.includes('token=abc'), false);
        return true;
      },
    );
  });

  void it('keeps verification copy free of household details', () => {
    const text = verificationEmailText(
      'https://api.roomies.example/api/auth/verify-email?token=abc',
    );
    assert.equal(text.includes('Home'), false);
    assert.equal(text.includes('membership'), false);
  });
});
