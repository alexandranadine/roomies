export type DocumentCspInput = {
  /** Canonical API origin (scheme://host[:port]). Omitted connect-src extra when unset. */
  apiOrigin?: string;
  /**
   * Canonical public R2 S3 origin (scheme://host[:port]). Added to connect-src
   * only — never img-src. Home photos render from blob: URLs.
   */
  r2S3Origin?: string;
};

function renderConnectSrc(input: DocumentCspInput): string {
  const parts = ["'self'"];
  if (input.apiOrigin !== undefined && input.apiOrigin.length > 0) {
    parts.push(input.apiOrigin);
  }
  if (input.r2S3Origin !== undefined && input.r2S3Origin.length > 0) {
    parts.push(input.r2S3Origin);
  }
  return parts.join(' ');
}

/**
 * Minimal document CSP for the Vite/React frontend origin.
 *
 * Assets, fonts, and scripts are self-hosted. The JSON API lives on a separate
 * origin (`connect-src`). Direct Home-photo object transfer uses an exact
 * public R2 S3 origin on `connect-src`. Images may use `blob:` object URLs.
 * No `unsafe-eval`. No host wildcards.
 */
export function renderDocumentCsp(input: DocumentCspInput = {}): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${renderConnectSrc(input)}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

export type CloudflareHeadersInput = {
  apiOrigin?: string;
  r2S3Origin?: string;
};

/**
 * Cloudflare Workers Static Assets `_headers` file.
 *
 * Hashed Vite assets are immutable. HTML revalidates. CSP belongs on this
 * document origin, not on the JSON API.
 */
export function renderCloudflareHeaders(input: CloudflareHeadersInput): string {
  const csp = renderDocumentCsp({
    apiOrigin: input.apiOrigin,
    r2S3Origin: input.r2S3Origin,
  });
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
