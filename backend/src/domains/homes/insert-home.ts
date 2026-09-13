import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';

export type NewHome = Readonly<{
  id: string;
  name: string;
  timezone: string;
  createdAt: Date;
}>;

export const INSERT_HOME_SQL = `
INSERT INTO homes (id, name, timezone, created_at, updated_at)
VALUES ($1::uuid, $2, $3, $4::timestamptz, $4::timestamptz)
`;

/** Home-owned insert. Does not write sibling tables or emit events. */
export async function insertHome(
  tx: TransactionContext,
  home: NewHome,
): Promise<void> {
  try {
    const result = await tx.query(INSERT_HOME_SQL, [
      home.id,
      home.name,
      home.timezone,
      home.createdAt,
    ]);
    if (result.rowCount !== 1) {
      throw new TransactionInfrastructureError();
    }
  } catch (error) {
    if (error instanceof TransactionInfrastructureError) {
      throw error;
    }
    throw new TransactionInfrastructureError();
  }
}
