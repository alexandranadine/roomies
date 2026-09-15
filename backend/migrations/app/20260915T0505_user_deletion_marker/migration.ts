#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/a9434aeae1f23745b9e2c092fad6f881ab6c6012eaf2dc0ec771d8cd7104bd7b/contract';
import startContract from '../../snapshots/a9434aeae1f23745b9e2c092fad6f881ab6c6012eaf2dc0ec771d8cd7104bd7b/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/c76976f9ed0fda7719fe337fc5eb28268dd5c36d0d9dbcaff020e80f845bab61/contract';
import endContract from '../../snapshots/c76976f9ed0fda7719fe337fc5eb28268dd5c36d0d9dbcaff020e80f845bab61/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'users',
        column: col('deleted_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-temporal@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
