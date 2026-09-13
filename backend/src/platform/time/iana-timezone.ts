/**
 * Runtime IANA timezone validation. Uses the host ICU inventory rather than
 * a handwritten zone list. UTC is always accepted (ticket + ICU alias).
 */
const SUPPORTED_IANA_TIME_ZONES = new Set<string>([
  'UTC',
  ...Intl.supportedValuesOf('timeZone'),
]);

export class InvalidIanaTimeZoneError extends Error {
  override readonly name = 'InvalidIanaTimeZoneError';

  constructor() {
    super('Invalid IANA timezone');
  }
}

export function canonicalizeIanaTimeZone(raw: string): string {
  const timezone = raw.trim();
  if (timezone.length === 0 || !SUPPORTED_IANA_TIME_ZONES.has(timezone)) {
    throw new InvalidIanaTimeZoneError();
  }
  return timezone;
}
