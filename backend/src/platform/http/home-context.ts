import type { Request, RequestHandler, Response } from 'express';
import { UnauthenticatedError } from '../auth/errors.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
  isActiveHomeActor,
  type ActiveHomeActor,
  type ActiveHomeActorResolver,
} from '../authz/index.js';
import { parsePathUuid } from './path-id.js';
import type { RequestWithPrincipal } from './require-auth.js';

const ACTIVE_HOME_ACTOR_LOCAL = 'activeHomeActor';

/**
 * Resolve ActiveHomeActor once per Home-scoped request after authentication
 * and path validation. Request-local reuse via res.locals — never written
 * onto the Better Auth principal.
 */
export function createRequireHomeContext(
  resolver: Pick<ActiveHomeActorResolver, 'resolve'>,
): RequestHandler {
  return (req, res, next) => {
    void resolveHomeContext(req, res, resolver).then(() => {
      next();
    }, next);
  };
}

async function resolveHomeContext(
  req: Request,
  res: Response,
  resolver: Pick<ActiveHomeActorResolver, 'resolve'>,
): Promise<void> {
  const principal = (req as Partial<RequestWithPrincipal>).principal;
  if (principal === undefined || typeof principal.userId !== 'string') {
    throw new UnauthenticatedError();
  }

  const homeId = parsePathUuid(req.params['homeId']);
  const actor = await resolver.resolve({
    userId: principal.userId,
    homeId,
  });
  if (actor === null) {
    throw new ConcealedNotFoundError();
  }

  const locals = res.locals as Record<string, unknown>;
  locals[ACTIVE_HOME_ACTOR_LOCAL] = actor;
}

export function getActiveHomeActor(res: Response): ActiveHomeActor {
  const locals = res.locals as Record<string, unknown>;
  const actor = locals[ACTIVE_HOME_ACTOR_LOCAL];
  if (!isActiveHomeActor(actor)) {
    throw new AuthorizationIntegrityError();
  }
  return actor;
}
