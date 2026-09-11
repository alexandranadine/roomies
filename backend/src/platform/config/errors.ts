/**
 * Thrown when environment configuration cannot be parsed.
 * Messages name variables and describe failures; they never include secret values.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
  }
}

/** Environment keys whose raw values must never appear in error output. */
export const SECRET_ENV_KEYS = new Set(['DATABASE_URL', 'AUTH_SECRET']);
