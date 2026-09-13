#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/64d43d201edd6675c3b3665ec0c764020e54aff2ff974646026e0eeaedbdb534/contract';
import startContract from '../../snapshots/64d43d201edd6675c3b3665ec0c764020e54aff2ff974646026e0eeaedbdb534/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/af531590032cdd8c8c3fd02ba04f1c6a81eb78a7874402afd20497d3dca980c5/contract';
import endContract from '../../snapshots/af531590032cdd8c8c3fd02ba04f1c6a81eb78a7874402afd20497d3dca980c5/contract.json' with { type: 'json' };
import {
  col,
  Migration,
  MigrationCLI,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'task_definitions',
        column: col('next_occurrence_date', 'date', {
          codecRef: { codecId: 'pg/date-string@1' },
        }),
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'task_definitions',
        constraint: 'task_definitions_scheduling_lifecycle_check',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'task_definitions',
        constraint: 'task_definitions_scheduling_lifecycle_check',
        expression:
          '(((deactivated_at IS NULL) AND (next_occurrence_date IS NOT NULL) AND (next_occurrence_at IS NOT NULL)) OR ((deactivated_at IS NOT NULL) AND (next_occurrence_date IS NULL) AND (next_occurrence_at IS NULL)))',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
