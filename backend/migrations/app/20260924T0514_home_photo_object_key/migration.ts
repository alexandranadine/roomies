#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/10b42e58a246ab56874f0985069a85787999dcd032a5f5fbea26067e6493e659/contract';
import endContract from '../../snapshots/10b42e58a246ab56874f0985069a85787999dcd032a5f5fbea26067e6493e659/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/c76976f9ed0fda7719fe337fc5eb28268dd5c36d0d9dbcaff020e80f845bab61/contract';
import startContract from '../../snapshots/c76976f9ed0fda7719fe337fc5eb28268dd5c36d0d9dbcaff020e80f845bab61/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'homes',
        column: col('photo_object_key', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'homes',
        constraint: 'homes_photo_object_key_canonical_check',
        expression:
          "((photo_object_key IS NULL) OR (photo_object_key ~ '^homes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/photo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.webp$'::text))",
      }),
      this.createIndex({
        schema: 'public',
        table: 'homes',
        index: 'homes_photo_object_key_uidx_746e59cb',
        columns: ['photo_object_key'],
        extras: { unique: true },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
