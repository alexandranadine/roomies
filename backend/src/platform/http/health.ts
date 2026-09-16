import { Router } from 'express';
import type { PersistenceReadiness } from '../persistence/readiness.js';

export type HealthRouterOptions = {
  /** Hex git SHA. Omitted from payloads when unset. */
  releaseSha?: string;
};

function probePayload(
  status: string,
  releaseSha: string | undefined,
): { status: string; release?: string } {
  if (releaseSha) {
    return { status, release: releaseSha };
  }
  return { status };
}

/**
 * Platform health endpoints.
 *
 * Response shape is intentionally simpler than the API error envelope:
 * these are process/infra probes, not product API resources.
 *
 * `/health` is liveness (process alive). `/ready` is readiness (config already
 * validated at boot; database reachable). Neither returns secrets, env dumps,
 * or stack traces.
 */
export function createHealthRouter(
  readiness: PersistenceReadiness,
  options: HealthRouterOptions = {},
): Router {
  const router = Router();
  const releaseSha = options.releaseSha;

  router.get('/health', (_req, res) => {
    res.status(200).json(probePayload('ok', releaseSha));
  });

  router.get('/ready', async (_req, res) => {
    const ready = await readiness.checkReady();
    if (ready) {
      res.status(200).json(probePayload('ready', releaseSha));
      return;
    }
    res.status(503).json({ status: 'not_ready' });
  });

  return router;
}
