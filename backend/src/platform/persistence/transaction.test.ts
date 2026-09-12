import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthorizationIntegrityError } from '../authz/errors.js';
import { TransactionInfrastructureError } from './errors.js';
import {
  runInReadCommittedTransaction,
  type TransactionClient,
  type TransactionContext,
  type TransactionPool,
} from './transaction.js';

type ScriptedResult = { rows: unknown[]; rowCount: number | null };

class ScriptedClient implements TransactionClient {
  readonly commands: string[] = [];
  released = false;
  beginError?: Error;
  commitError?: Error;
  rollbackError?: Error;
  workQueryError?: Error;
  rollbackCount = 0;

  query(text: string, values?: unknown[]): Promise<ScriptedResult> {
    void values;
    this.commands.push(text);
    if (text.startsWith('BEGIN') && this.beginError) {
      return Promise.reject(this.beginError);
    }
    if (text === 'COMMIT' && this.commitError) {
      return Promise.reject(this.commitError);
    }
    if (text === 'ROLLBACK') {
      this.rollbackCount += 1;
      if (this.rollbackError) {
        return Promise.reject(this.rollbackError);
      }
    }
    if (!text.startsWith('BEGIN') && text !== 'COMMIT' && text !== 'ROLLBACK') {
      if (this.workQueryError) {
        return Promise.reject(this.workQueryError);
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  release(): void {
    this.released = true;
  }
}

function poolOf(client: ScriptedClient): TransactionPool & { ended: boolean } {
  const pool = {
    ended: false,
    connect() {
      return Promise.resolve(client);
    },
    end() {
      pool.ended = true;
    },
  };
  return pool;
}

void describe('runInReadCommittedTransaction', () => {
  void it('begins READ COMMITTED, commits, and releases the client', async () => {
    const client = new ScriptedClient();
    const pool = poolOf(client);
    const seen: TransactionContext[] = [];

    const value = await runInReadCommittedTransaction(pool, async (tx) => {
      seen.push(tx);
      await tx.query('SELECT 1');
      return 42;
    });

    assert.equal(value, 42);
    assert.equal(seen.length, 1);
    assert.equal(client.commands[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
    assert.equal(client.commands.at(-1), 'COMMIT');
    assert.equal(client.commands.includes('ROLLBACK'), false);
    assert.equal(client.released, true);
    assert.equal(pool.ended, false);
  });

  void it('rolls back and preserves the original application error', async () => {
    const client = new ScriptedClient();
    const original = new Error('application boom');

    await assert.rejects(
      () =>
        runInReadCommittedTransaction(poolOf(client), () => {
          return Promise.reject(original);
        }),
      (error: unknown) => error === original,
    );

    assert.equal(client.commands.includes('ROLLBACK'), true);
    assert.equal(client.commands.includes('COMMIT'), false);
    assert.equal(client.released, true);
  });

  void it('rolls back when a persistence query fails and rethrows that error', async () => {
    const client = new ScriptedClient();
    const queryError = new Error('relation does not exist');
    client.workQueryError = queryError;

    await assert.rejects(
      () =>
        runInReadCommittedTransaction(poolOf(client), async (tx) => {
          await tx.query('INSERT INTO homes (id) VALUES ($1)', ['x']);
          return 'ok';
        }),
      (error: unknown) => error === queryError,
    );

    assert.equal(client.rollbackCount, 1);
    assert.equal(client.released, true);
  });

  void it('maps rollback failure to a transaction infrastructure error', async () => {
    const client = new ScriptedClient();
    client.rollbackError = new Error('SQLSTATE 40P01 deadlock detail');

    await assert.rejects(
      () =>
        runInReadCommittedTransaction(poolOf(client), () =>
          Promise.reject(new Error('application boom')),
        ),
      (error: unknown) => {
        assert.ok(error instanceof TransactionInfrastructureError);
        assert.equal(error instanceof AuthorizationIntegrityError, false);
        assert.equal(error.message, 'Transaction infrastructure failure');
        assert.equal(
          String(error).includes('deadlock') ||
            String(error).includes('40P01') ||
            String(error).includes('application boom'),
          false,
        );
        return true;
      },
    );
    assert.equal(client.released, true);
  });

  void it('maps BEGIN failure without exposing the database error', async () => {
    const client = new ScriptedClient();
    client.beginError = new Error('could not serialize access');

    await assert.rejects(
      () =>
        runInReadCommittedTransaction(poolOf(client), () => Promise.resolve(1)),
      (error: unknown) => {
        assert.ok(error instanceof TransactionInfrastructureError);
        assert.equal(error instanceof AuthorizationIntegrityError, false);
        assert.equal(String(error).includes('serialize'), false);
        return true;
      },
    );
    assert.equal(client.released, true);
  });

  void it('always releases the client after COMMIT failure', async () => {
    const client = new ScriptedClient();
    client.commitError = new Error('commit failed disk');

    await assert.rejects(
      () =>
        runInReadCommittedTransaction(poolOf(client), () => Promise.resolve(1)),
      (error: unknown) => {
        assert.ok(error instanceof TransactionInfrastructureError);
        assert.equal(error instanceof AuthorizationIntegrityError, false);
        return true;
      },
    );
    assert.equal(client.released, true);
    assert.equal(client.commands.includes('ROLLBACK'), true);
  });

  void it('passes one transaction context to multiple repository-style functions', async () => {
    const client = new ScriptedClient();
    const contexts = new Set<TransactionContext>();

    async function writeA(tx: TransactionContext): Promise<void> {
      contexts.add(tx);
      await tx.query('SELECT a');
    }
    async function writeB(tx: TransactionContext): Promise<void> {
      contexts.add(tx);
      await tx.query('SELECT b');
    }

    await runInReadCommittedTransaction(poolOf(client), async (tx) => {
      await writeA(tx);
      await writeB(tx);
    });

    assert.equal(contexts.size, 1);
    assert.equal(client.commands.includes('COMMIT'), true);
  });
});
