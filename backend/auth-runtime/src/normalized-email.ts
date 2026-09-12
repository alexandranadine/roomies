const MAX_EMAIL_LENGTH = 254;
const LOCAL_PART_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FINAL_DOMAIN_LABEL_PATTERN = /^[a-z]{2,63}$/;

declare const normalizedEmailBrand: unique symbol;

export type NormalizedEmail = string & {
  readonly [normalizedEmailBrand]: true;
};

export class InvalidNormalizedEmailError extends Error {
  constructor() {
    super('Unsupported email address');
    this.name = 'InvalidNormalizedEmailError';
  }
}

/**
 * Roomies' single supported-email contract: trim, lowercase, then validate a
 * deliberately small ASCII subset. Provider-specific rewriting is forbidden.
 */
export function normalizeEmail(value: string): NormalizedEmail {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    !/^[\x21-\x7e]+$/.test(normalized)
  ) {
    throw new InvalidNormalizedEmailError();
  }

  const separator = normalized.indexOf('@');
  if (separator <= 0 || separator !== normalized.lastIndexOf('@')) {
    throw new InvalidNormalizedEmailError();
  }

  const localPart = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  if (
    !LOCAL_PART_PATTERN.test(localPart) ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..')
  ) {
    throw new InvalidNormalizedEmailError();
  }

  const labels = domain.split('.');
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label)) ||
    !FINAL_DOMAIN_LABEL_PATTERN.test(labels.at(-1) ?? '')
  ) {
    throw new InvalidNormalizedEmailError();
  }

  return normalized as NormalizedEmail;
}
