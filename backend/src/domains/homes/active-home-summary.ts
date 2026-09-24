import type { MembershipRole } from '../../platform/authz/context.js';

/**
 * Server-authoritative active Home the canonical User may currently enter.
 * Role is the current tenure only — not a capability grant.
 *
 * `photoObjectKey` is DOMAIN-ONLY. Never spread this model into an HTTP
 * response; map through the discovery DTO whitelist (`hasPhoto`) instead.
 */
export type ActiveHomeSummary = Readonly<{
  id: string;
  name: string;
  timezone: string;
  role: MembershipRole;
  photoObjectKey: string | null;
}>;
