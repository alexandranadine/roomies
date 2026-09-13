import type { ActiveHome } from './homes-api.js';

/** User-visible role copy. Never "Owner" or "Membership". */
export function homeRoleLabel(role: ActiveHome['role']): string {
  return role === 'ADMIN' ? 'Home Admin' : 'Roommate';
}
