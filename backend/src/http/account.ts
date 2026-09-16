import { Router } from 'express';
import { z } from 'zod';
import type {
  DeleteAccountLifecycleInput,
  DeleteAccountLifecycleResult,
} from '../application/account/delete-account-lifecycle.js';
import {
  appendExpiredAuthSessionCookieAfterCommit,
  AuthInfrastructureError,
  type AuthRuntime,
} from '../platform/auth/index.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import { InvalidRequestError } from '../platform/authz/index.js';
import { setPrivateNoStoreHeaders } from '../platform/http/private-response.js';
import {
  createRequireAuth,
  type RequestWithPrincipal,
} from '../platform/http/require-auth.js';
import type { Clock } from '../platform/time/clock.js';
import { systemClock } from '../platform/time/clock.js';
import { requireFreshAccountDeletionSession } from './account-deletion-fresh-session.js';

export const deleteAccountBodySchema = z
  .object({
    confirmation: z.literal('DELETE'),
  })
  .strict();

export type DeleteAccountCommand = (
  input: DeleteAccountLifecycleInput,
) => Promise<DeleteAccountLifecycleResult>;

export type CreateAccountRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  deleteAccount: DeleteAccountCommand;
  auth: AuthRuntime;
  clock?: Clock;
};

function parseDeleteAccountBody(body: unknown): void {
  if (!deleteAccountBodySchema.safeParse(body).success) {
    throw new InvalidRequestError();
  }
}

/**
 * Authenticated account-deletion route. Mount at `/account` on the v1 router.
 * Origin/CSRF is enforced by the `/api/v1` mutation guard before this router.
 *
 * TODO(launch): include this sensitive operation in credential/sensitive-
 * operation rate limiting before public launch. Do not add a limiter here.
 */
export function createAccountRouter(
  options: CreateAccountRouterOptions,
): Router {
  const clock = options.clock ?? systemClock;
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));

  router.delete('/', (req, res, next) => {
    void (async () => {
      const { principal } = req as RequestWithPrincipal;
      requireFreshAccountDeletionSession(principal.sessionCreatedAt, clock);
      parseDeleteAccountBody(req.body);

      const result = await options.deleteAccount({
        userId: principal.userId,
      });
      if (
        result.outcome !== 'completed' &&
        result.outcome !== 'already_deleted'
      ) {
        throw new AuthInfrastructureError();
      }

      appendExpiredAuthSessionCookieAfterCommit(res, 'committed', options.auth);
      res.status(204).end();
    })().catch(next);
  });

  return router;
}
