import { Router } from 'express';
import type { PersistenceReadiness } from '../persistence/readiness.js';

/**
 * Platform health endpoints.
 *
 * Response shape is intentionally simpler than the API error envelope:
 * these are process/infra probes, not product API resources.
 */
export function createHealthRouter(readiness: PersistenceReadiness): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    const ready = await readiness.checkReady();
    if (ready) {
      res.status(200).json({ status: 'ready' });
      return;
    }
    res.status(503).json({ status: 'not_ready' });
  });

  return router;
}
