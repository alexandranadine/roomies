/**
 * Small readiness port for HTTP `/ready` checks.
 * Keeps Express free of Prisma imports; runtime composition adapts the DB client.
 */
export type PersistenceReadiness = {
  /** Returns true when persistence is reachable for traffic. */
  checkReady: () => Promise<boolean>;
};

/**
 * Adapt a Prisma Postgres client to the readiness port.
 * Uses `connect()` as a connectivity probe (no domain queries).
 */
export function createDbReadiness(db: {
  connect: () => Promise<unknown>;
}): PersistenceReadiness {
  return {
    async checkReady() {
      try {
        await db.connect();
        return true;
      } catch {
        return false;
      }
    },
  };
}
