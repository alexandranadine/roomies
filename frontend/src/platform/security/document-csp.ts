export type DocumentCspInput = {
  /** Canonical API origin (scheme://host[:port]). Omitted connect-src extra when unset. */
  apiOrigin?: string;
};

/**
 * Minimal document CSP for the Vite/React frontend origin.
 *
 * Assets, fonts, and scripts are self-hosted. The JSON API lives on a separate
 * origin (`connect-src`). No `unsafe-eval`. No host wildcards.
 */
export function renderDocumentCsp(input: DocumentCspInput = {}): string {
  const connectSrc = input.apiOrigin ? `'self' ${input.apiOrigin}` : "'self'";

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

export type CloudflareHeadersInput = {
  apiOrigin?: string;
};

/**
 * Cloudflare Workers Static Assets `_headers` file.
 *
 * Hashed Vite assets are immutable. HTML revalidates. CSP belongs on this
 * document origin, not on the JSON API.
 */
export function renderCloudflareHeaders(input: CloudflareHeadersInput): string {
  const csp = renderDocumentCsp({ apiOrigin: input.apiOrigin });
  return [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  X-Frame-Options: DENY',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Strict-Transport-Security: max-age=15552000; includeSubDomains',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
}

export function assertDocumentCspSane(csp: string): void {
  if (csp.includes('*')) {
    throw new Error('document CSP must not contain wildcards');
  }
  if (csp.includes('unsafe-eval')) {
    throw new Error('document CSP must not allow unsafe-eval');
  }
  if (!csp.includes("script-src 'self'")) {
    throw new Error("document CSP must include script-src 'self'");
  }
}
