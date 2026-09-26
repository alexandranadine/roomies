import { EMAIL_PASSWORD_RESET_EXPIRES_IN_SECONDS } from './types.js';

const EXPIRATION_HOURS = EMAIL_PASSWORD_RESET_EXPIRES_IN_SECONDS / 3600;

export const PASSWORD_RESET_EMAIL_SUBJECT = 'Reset your Roomies password';

export function passwordResetEmailText(resetUrl: string): string {
  return [
    'Roomies',
    '',
    'A password reset was requested for this email.',
    '',
    'Reset your password by opening this link:',
    '',
    resetUrl,
    '',
    `This link expires in ${EXPIRATION_HOURS} hour.`,
    '',
    "If you didn't request this, you can ignore this email.",
  ].join('\n');
}

export function passwordResetEmailHtml(resetUrl: string): string {
  const safeHref = escapeHtmlAttribute(resetUrl);
  return [
    '<p>Roomies</p>',
    '<p>A password reset was requested for this email.</p>',
    `<p><a href="${safeHref}">Reset your password</a></p>`,
    `<p>This link expires in ${EXPIRATION_HOURS} hour.</p>`,
    "<p>If you didn't request this, you can ignore this email.</p>",
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
