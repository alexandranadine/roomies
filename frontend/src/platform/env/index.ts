import { parseFrontendEnv, type FrontendEnv } from './parse-env.js';

let cached: FrontendEnv | undefined;

/** Parse and cache env from Vite's `import.meta.env` (once per page load). */
export function getFrontendEnv(): FrontendEnv {
  if (cached === undefined) {
    cached = parseFrontendEnv(
      { VITE_API_ORIGIN: import.meta.env.VITE_API_ORIGIN },
      { isDevelopment: import.meta.env.DEV },
    );
  }
  return cached;
}

/** Test helper — clears the process-local cache. */
export function resetFrontendEnvCacheForTests(): void {
  cached = undefined;
}
