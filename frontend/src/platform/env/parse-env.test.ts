import { describe, expect, it } from 'vitest';
import {
  DEV_DEFAULT_API_ORIGIN,
  FrontendEnvError,
  parseFrontendEnv,
} from './parse-env.js';

const VALID_R2_ORIGIN = 'https://abc123.r2.cloudflarestorage.com';

describe('parseFrontendEnv', () => {
  it('accepts a valid development configuration', () => {
    const env = parseFrontendEnv(
      { VITE_API_ORIGIN: 'http://localhost:3000' },
      { isDevelopment: true },
    );

    expect(env.apiOrigin).toBe('http://localhost:3000');
  });

  it('defaults to the local backend in development when unset', () => {
    const env = parseFrontendEnv({}, { isDevelopment: true });
    expect(env.apiOrigin).toBe(DEV_DEFAULT_API_ORIGIN);
    expect(env.r2S3Origin).toBeUndefined();
  });

  it('normalizes trailing slashes on valid origins', () => {
    const env = parseFrontendEnv(
      { VITE_API_ORIGIN: 'https://api.example.com/' },
      { isDevelopment: false },
    );
    expect(env.apiOrigin).toBe('https://api.example.com');
  });

  it('rejects a malformed API origin', () => {
    expect(() =>
      parseFrontendEnv(
        { VITE_API_ORIGIN: 'not-a-url' },
        { isDevelopment: true },
      ),
    ).toThrow(FrontendEnvError);

    expect(() =>
      parseFrontendEnv(
        { VITE_API_ORIGIN: 'http://localhost:3000/api' },
        { isDevelopment: true },
      ),
    ).toThrow(/must not include a path/i);
  });

  it('does not silently default to localhost for deployed builds', () => {
    expect(() => parseFrontendEnv({}, { isDevelopment: false })).toThrow(
      /required for deployed builds/i,
    );

    expect(() =>
      parseFrontendEnv({ VITE_API_ORIGIN: '   ' }, { isDevelopment: false }),
    ).toThrow(/required for deployed builds/i);
  });

  it('does not accept mail or object-store secrets as public Vite env', () => {
    const env = parseFrontendEnv(
      { VITE_API_ORIGIN: 'https://api.roomies.example' },
      { isDevelopment: false },
    );
    expect(env).toEqual({ apiOrigin: 'https://api.roomies.example' });
    expect(Object.keys(env)).toEqual(['apiOrigin']);
    expect(JSON.stringify(env)).not.toMatch(
      /EMAIL_API_KEY|AUTH_SECRET|DATABASE_URL|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_ACCOUNT_ID/,
    );
  });

  it('does not declare email-provider secrets as Vite public env', () => {
    const declared = Object.keys(
      parseFrontendEnv(
        { VITE_API_ORIGIN: 'https://api.roomies.example' },
        { isDevelopment: false },
      ),
    );
    expect(declared).toEqual(['apiOrigin']);
    expect(declared.join(',')).not.toMatch(
      /EMAIL_API_KEY|EMAIL_FROM|EMAIL_PROVIDER/,
    );
  });

  it('accepts an exact public R2 S3 origin', () => {
    const env = parseFrontendEnv(
      {
        VITE_API_ORIGIN: 'https://api.roomies.example',
        VITE_R2_S3_ORIGIN: `${VALID_R2_ORIGIN}/`,
      },
      { isDevelopment: false },
    );
    expect(env.r2S3Origin).toBe(VALID_R2_ORIGIN);
    expect(Object.keys(env).sort()).toEqual(['apiOrigin', 'r2S3Origin']);
  });

  it('rejects a malformed, wildcard, credentialed, or path-containing R2 S3 origin', () => {
    const invalid = [
      'not-a-url',
      'https://*.r2.cloudflarestorage.com',
      'https://abc123.r2.cloudflarestorage.com/bucket',
      'https://user:pass@abc123.r2.cloudflarestorage.com',
    ];

    for (const VITE_R2_S3_ORIGIN of invalid) {
      expect(() =>
        parseFrontendEnv(
          {
            VITE_API_ORIGIN: 'https://api.roomies.example',
            VITE_R2_S3_ORIGIN,
          },
          { isDevelopment: false },
        ),
      ).toThrow(FrontendEnvError);
    }
  });

  it('treats VITE_R2_S3_ORIGIN as public configuration, not a credential', () => {
    const env = parseFrontendEnv(
      {
        VITE_API_ORIGIN: 'https://api.roomies.example',
        VITE_R2_S3_ORIGIN: VALID_R2_ORIGIN,
      },
      { isDevelopment: false },
    );
    expect(env.r2S3Origin).toBe(VALID_R2_ORIGIN);
    expect(JSON.stringify(env)).not.toMatch(
      /R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/,
    );
  });
});
