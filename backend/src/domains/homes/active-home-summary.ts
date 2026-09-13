import type { MembershipRole } from '../../platform/authz/context.js';

/**
 * Server-authoritative active Home the canonical User may currently enter.
 * Role is the current tenure only — not a capability grant.
 */
export type ActiveHomeSummary = Readonly<{
  id: string;
  name: string;
  timezone: string;
  role: MembershipRole;
}>;
