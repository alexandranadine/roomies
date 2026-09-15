/**
 * Caller-requested lock for canonical Maintenance source projection reads.
 * `forUpdate` takes SELECT ... FOR UPDATE on the exact source row inside
 * the caller's transaction. Missing rows stay null after the lock wait.
 */
export type MaintenanceSourceLockMode = 'none' | 'forUpdate';

export function maintenanceSourceLockSql(
  baseSql: string,
  lock: MaintenanceSourceLockMode | undefined,
): string {
  if (lock === 'forUpdate') {
    return `${baseSql.trimEnd()}\nFOR UPDATE`;
  }
  return baseSql;
}
