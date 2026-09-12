import type { Pool } from 'pg';
import type { ActiveHomeActorResolver } from '../../platform/authz/index.js';
import { lookupActiveHomeActor } from './repository/active-home-actor-lookup.js';

/**
 * Public application interface for current Home/Membership tenure.
 * `null` deliberately conflates unknown, archived, absent, and ended-only
 * Membership history. Callers must not infer which condition occurred.
 */
export function createActiveHomeActorResolver(
  pool: Pool,
): ActiveHomeActorResolver {
  return {
    resolve(input) {
      return lookupActiveHomeActor(pool, input);
    },
  };
}

export type { ActiveHomeActorResolver };
