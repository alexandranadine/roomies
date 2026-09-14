#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/154a480f634392d8f058e3c55ebb272bf61dd8e322969b5abb0bd2ce11eeb916/contract';
import startContract from '../../snapshots/154a480f634392d8f058e3c55ebb272bf61dd8e322969b5abb0bd2ce11eeb916/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/df2cc11f0e0669a0a2cc5025be6501be26891a9766c59ef8b371af6cc72f1c84/contract';
import endContract from '../../snapshots/df2cc11f0e0669a0a2cc5025be6501be26891a9766c59ef8b371af6cc72f1c84/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'supply_entries',
        column: col('obtained_by_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'task_instances',
        column: col('completed_by_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'supply_entries',
        constraint: 'supply_entries_obtain_actor_check',
        expression: '((obtained_at IS NULL) = (obtained_by_membership_id IS NULL))',
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'task_instances',
        constraint: 'task_instances_completion_actor_check',
        expression: '((completed_at IS NULL) = (completed_by_membership_id IS NULL))',
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_entries',
        index: 'supply_entries_home_id_obtained_by_membership_id_idx_d353905d',
        columns: ['home_id', 'obtained_by_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_instances',
        index: 'task_instances_home_id_completed_by_membership_id_idx_746c7e3c',
        columns: ['home_id', 'completed_by_membership_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'supply_entries',
        foreignKey: {
          name: 'supply_entries_obtained_by_home_membership_fkey',
          columns: ['home_id', 'obtained_by_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_instances',
        foreignKey: {
          name: 'task_instances_completed_by_home_membership_fkey',
          columns: ['home_id', 'completed_by_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
