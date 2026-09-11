import { describe, expect, it } from 'vitest';
import {
  DEV_DEFAULT_API_ORIGIN,
  FrontendEnvError,
  parseFrontendEnv,
} from './parse-env.js';

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
});
