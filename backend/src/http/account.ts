import { Router, type RequestHandler } from 'express';
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
  rateLimitSensitive?: RequestHandler;
};

function parseDeleteAccountBody(body: unknown): void {
  if (!deleteAccountBodySchema.safeParse(body).success) {
    throw new InvalidRequestError();
  }
}

/**
 * Authenticated account-deletion route. Mount at `/account` on the v1 router.
 * Origin/CSRF is enforced by the `/api/v1` mutation guard before this router.
 * Sensitive-operation rate limiting, when provided, runs after auth and
 * before freshness, body parsing, and lifecycle work.
 */
export function createAccountRouter(
  options: CreateAccountRouterOptions,
): Router {
  const clock = options.clock ?? systemClock;
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));

  const deleteHandlers: RequestHandler[] = [];
  if (options.rateLimitSensitive !== undefined) {
    deleteHandlers.push(options.rateLimitSensitive);
  }
  deleteHandlers.push((req, res, next) => {
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

  router.delete('/', ...deleteHandlers);

  return router;
}
