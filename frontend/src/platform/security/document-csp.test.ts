import { describe, expect, it } from 'vitest';
import {
  assertDocumentCspSane,
  renderCloudflareHeaders,
  renderDocumentCsp,
} from './document-csp.js';

describe('document CSP', () => {
  it('is a minimal self-hosted policy with an exact API connect-src', () => {
    const csp = renderDocumentCsp({
      apiOrigin: 'https://api.roomies.example',
    });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self' https://api.roomies.example");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('*');
    assertDocumentCspSane(csp);
  });

  it('does not invent a connect-src host when the API origin is omitted', () => {
    const csp = renderDocumentCsp();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('https://');
    assertDocumentCspSane(csp);
  });
});

describe('Cloudflare _headers', () => {
  it('sets short-lived HTML cache and immutable hashed assets', () => {
    const headers = renderCloudflareHeaders({
      apiOrigin: 'https://api.roomies.example',
    });
    expect(headers).toContain('/*');
    expect(headers).toContain(
      'Cache-Control: public, max-age=0, must-revalidate',
    );
    expect(headers).toContain('/assets/*');
    expect(headers).toContain(
      'Cache-Control: public, max-age=31536000, immutable',
    );
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(headers).toContain('Content-Security-Policy:');
    expect(headers).toContain("connect-src 'self' https://api.roomies.example");
    expect(headers).not.toContain('unsafe-eval');
  });
});
