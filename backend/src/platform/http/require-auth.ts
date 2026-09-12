import type { Request, RequestHandler } from 'express';
import type {
  AuthenticatedPrincipal,
  PrincipalResolver,
} from '../auth/principal.js';

export type RequestWithPrincipal = Request & {
  principal: AuthenticatedPrincipal;
};

/**
 * Router-level `/api/v1` guard. Uses Roomies `requirePrincipal` only —
 * no Membership, Home, role, or capability lookup.
 */
export function createRequireAuth(
  resolver: Pick<PrincipalResolver, 'requirePrincipal'>,
): RequestHandler {
  return (req, _res, next) => {
    void resolver
      .requirePrincipal(req)
      .then((principal) => {
        (req as RequestWithPrincipal).principal = principal;
        next();
      })
      .catch(next);
  };
}
