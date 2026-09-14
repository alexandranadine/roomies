#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/86008540b79dc111c5b0c915ce7fc527efbdd99327fe50856f013473072a76db/contract';
import endContract from '../../snapshots/86008540b79dc111c5b0c915ce7fc527efbdd99327fe50856f013473072a76db/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/df2cc11f0e0669a0a2cc5025be6501be26891a9766c59ef8b371af6cc72f1c84/contract';
import startContract from '../../snapshots/df2cc11f0e0669a0a2cc5025be6501be26891a9766c59ef8b371af6cc72f1c84/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'membership_role_transitions',
        columns: [
          col('actor_membership_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('changed_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('membership_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'memberships',
        column: col('ended_by_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'memberships',
        constraint: 'memberships_end_actor_check',
        expression: '((ended_at IS NULL) = (ended_by_membership_id IS NULL))',
      }),
      this.createIndex({
        schema: 'public',
        table: 'membership_role_transitions',
        index: 'membership_role_transitions_home_id_actor_membership_i_59ee34c2',
        columns: ['home_id', 'actor_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'membership_role_transitions',
        index: 'membership_role_transitions_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'membership_role_transitions',
        index: 'membership_role_transitions_home_id_membership_id_idx_3d66ba27',
        columns: ['home_id', 'membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'memberships',
        index: 'memberships_home_id_ended_by_membership_id_idx_82a6b407',
        columns: ['home_id', 'ended_by_membership_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'membership_role_transitions',
        foreignKey: {
          name: 'membership_role_transitions_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'membership_role_transitions',
        foreignKey: {
          name: 'membership_role_transitions_subject_home_membership_fkey',
          columns: ['home_id', 'membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'membership_role_transitions',
        foreignKey: {
          name: 'membership_role_transitions_actor_home_membership_fkey',
          columns: ['home_id', 'actor_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'memberships',
        foreignKey: {
          name: 'memberships_ended_by_home_membership_fkey',
          columns: ['home_id', 'ended_by_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
