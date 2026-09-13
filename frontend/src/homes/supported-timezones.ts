/** Matches backend HOME_NAME_MAX_LENGTH. */
export const HOME_NAME_MAX_LENGTH = 80;

let cachedSupportedTimeZones: readonly string[] | undefined;

/**
 * Runtime IANA zones from ICU plus UTC for backend parity.
 */
export function getSupportedTimeZones(): readonly string[] {
  if (cachedSupportedTimeZones !== undefined) {
    return cachedSupportedTimeZones;
  }

  const zones = new Set<string>(Intl.supportedValuesOf('timeZone'));
  zones.add('UTC');
  cachedSupportedTimeZones = [...zones].sort((left, right) =>
    left.localeCompare(right),
  );
  return cachedSupportedTimeZones;
}

export function isSupportedTimeZone(value: string): boolean {
  return getSupportedTimeZones().includes(value);
}

/**
 * Browser-reported zone when ICU recognizes it. Not treated as authority.
 */
export function getDefaultBrowserTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timeZone === 'string' && isSupportedTimeZone(timeZone)) {
      return timeZone;
    }
  } catch {
    // Host lacks Intl support; leave selection to the User.
  }
  return undefined;
}

export function resetSupportedTimeZonesForTests(): void {
  cachedSupportedTimeZones = undefined;
}
