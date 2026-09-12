import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

export const ARCHIVE_ACTIVE_HOME_SQL = `
UPDATE homes
SET archived_at = $1
WHERE id = $2
  AND archived_at IS NULL
`;

export type HomeArchiveWriter = {
  archiveActiveHome(
    tx: TransactionContext,
    input: Readonly<{ homeId: string; archivedAt: Date }>,
  ): Promise<number>;
};

/** Home-owned exact archived_at-only writer. */
export function createHomeArchiveWriter(): HomeArchiveWriter {
  return Object.freeze({
    async archiveActiveHome(tx, input) {
      try {
        const result = await tx.query(ARCHIVE_ACTIVE_HOME_SQL, [
          input.archivedAt,
          input.homeId,
        ]);
        return result.rowCount ?? 0;
      } catch {
        throw new TransactionInfrastructureError();
      }
    },
  });
}
