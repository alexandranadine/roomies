import type { PoolClient } from 'pg';
import { TransactionInfrastructureError } from './errors.js';

/**
 * Narrow query surface for one READ COMMITTED transaction.
 * Later same-transaction writers receive this same context.
 */
export type TransactionContext = Readonly<{
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
}>;

export type TransactionClient = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
};

export type TransactionPool = {
  connect(): Promise<TransactionClient | PoolClient>;
};

function createTransactionContext(
  client: TransactionClient | PoolClient,
): TransactionContext {
  return Object.freeze({
    async query<T = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) {
      const result = values
        ? await client.query(text, [...values])
        : await client.query(text);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount,
      };
    },
  });
}

const READ_COMMITTED_BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';
const REPEATABLE_READ_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ';

async function runInIsolatedTransaction<T>(
  pool: TransactionPool,
  beginSql: typeof READ_COMMITTED_BEGIN | typeof REPEATABLE_READ_BEGIN,
  work: (tx: TransactionContext) => Promise<T>,
): Promise<T> {
  let client: TransactionClient | PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new TransactionInfrastructureError();
  }

  try {
    try {
      await client.query(beginSql);
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        throw new TransactionInfrastructureError();
      }
      throw new TransactionInfrastructureError();
    }

    try {
      const result = await work(createTransactionContext(client));
      try {
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          throw new TransactionInfrastructureError();
        }
        throw new TransactionInfrastructureError();
      }
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        throw new TransactionInfrastructureError();
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Run work on one client from the caller-owned pool.
 * BEGIN READ COMMITTED → work → COMMIT, or ROLLBACK on failure.
 * Does not close the pool.
 */
export async function runInReadCommittedTransaction<T>(
  pool: TransactionPool,
  work: (tx: TransactionContext) => Promise<T>,
): Promise<T> {
  return runInIsolatedTransaction(pool, READ_COMMITTED_BEGIN, work);
}

/**
 * Run work on one client from the caller-owned pool.
 * BEGIN REPEATABLE READ → work → COMMIT, or ROLLBACK on failure.
 * The first statement inside `work` establishes the snapshot.
 * Does not close the pool.
 */
export async function runInRepeatableReadTransaction<T>(
  pool: TransactionPool,
  work: (tx: TransactionContext) => Promise<T>,
): Promise<T> {
  return runInIsolatedTransaction(pool, REPEATABLE_READ_BEGIN, work);
}
