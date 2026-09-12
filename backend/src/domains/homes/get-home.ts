import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import type { Home } from './home.js';
import { decideHomeRead } from './policies.js';
import type { HomeReader } from './repository/home-repository.js';

/**
 * Authorized Home read. Policy denial and a missing/archived Home are both
 * concealed — this use case does not distinguish those conditions.
 */
export async function getHome(
  input: { actor: ActiveHomeActor; homeId: string },
  homes: Pick<HomeReader, 'findActiveHomeById'>,
): Promise<Home> {
  const decision = decideHomeRead({
    actor: input.actor,
    targetHomeId: input.homeId,
  });
  if (!decision.allowed) {
    throw new ConcealedNotFoundError();
  }

  const home = await homes.findActiveHomeById(input.homeId);
  if (home === null) {
    throw new ConcealedNotFoundError();
  }

  return home;
}
