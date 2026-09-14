/**
 * Compact locale-aware timestamp for Activity `occurredAt`.
 * Invalid values return empty so raw strings are never shown as a fallback.
 */
export function formatActivityTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return '';
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
