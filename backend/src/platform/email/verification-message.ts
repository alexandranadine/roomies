import { EMAIL_VERIFICATION_EXPIRES_IN_SECONDS } from './types.js';

const EXPIRATION_HOURS = EMAIL_VERIFICATION_EXPIRES_IN_SECONDS / 3600;

export const VERIFICATION_EMAIL_SUBJECT = 'Verify your Roomies email';

export function verificationEmailText(verificationUrl: string): string {
  return [
    'Roomies',
    '',
    'Verify your email address by opening this link:',
    '',
    verificationUrl,
    '',
    `This link expires in ${EXPIRATION_HOURS} hour.`,
    '',
    'If you did not create or request a Roomies account, you can ignore this email.',
  ].join('\n');
}

export function verificationEmailHtml(verificationUrl: string): string {
  const safeHref = escapeHtmlAttribute(verificationUrl);
  return [
    '<p>Roomies</p>',
    '<p>Verify your email address by opening this link:</p>',
    `<p><a href="${safeHref}">Verify email address</a></p>`,
    `<p>This link expires in ${EXPIRATION_HOURS} hour.</p>`,
    '<p>If you did not create or request a Roomies account, you can ignore this email.</p>',
  ].join('');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
