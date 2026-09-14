#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/86008540b79dc111c5b0c915ce7fc527efbdd99327fe50856f013473072a76db/contract';
import startContract from '../../snapshots/86008540b79dc111c5b0c915ce7fc527efbdd99327fe50856f013473072a76db/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a9434aeae1f23745b9e2c092fad6f881ab6c6012eaf2dc0ec771d8cd7104bd7b/contract';
import endContract from '../../snapshots/a9434aeae1f23745b9e2c092fad6f881ab6c6012eaf2dc0ec771d8cd7104bd7b/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'notifications',
        columns: [
          col('actor_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('occurred_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('read_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('recipient_membership_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('source_entity_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('source_entity_type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source_outbox_event_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'notifications_kind_check_c456c50a',
            "\"kind\" IN ('MEMBERSHIP_ROLE_CHANGED', 'ASSIGNED_TASK_COMPLETED', 'CREATED_SUPPLY_OBTAINED', 'PRIVATE_MAINTENANCE_CREATED', 'PRIVATE_MAINTENANCE_RESOLVED')",
          ),
          checkExpression(
            'notifications_kind_source_check',
            "(((kind = 'MEMBERSHIP_ROLE_CHANGED'::text) AND (source_entity_type = 'MEMBERSHIP'::text)) OR ((kind = 'ASSIGNED_TASK_COMPLETED'::text) AND (source_entity_type = 'TASK'::text)) OR ((kind = 'CREATED_SUPPLY_OBTAINED'::text) AND (source_entity_type = 'SUPPLY'::text)) OR ((kind = 'PRIVATE_MAINTENANCE_CREATED'::text) AND (source_entity_type = 'MAINTENANCE'::text)) OR ((kind = 'PRIVATE_MAINTENANCE_RESOLVED'::text) AND (source_entity_type = 'MAINTENANCE'::text)))",
          ),
          checkExpression(
            'notifications_source_entity_type_check_0ee9d6e1',
            "\"source_entity_type\" IN ('MEMBERSHIP', 'TASK', 'SUPPLY', 'MAINTENANCE')",
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_actor_membership_id_idx_a5b20b69',
        columns: ['actor_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_home_id_actor_membership_id_idx_59ee34c2',
        columns: ['home_id', 'actor_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_home_id_recipient_membership_id_idx_d6e4e47a',
        columns: ['home_id', 'recipient_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_home_recipient_occurred_idx_97c4c8ff',
        columns: ['home_id', 'recipient_membership_id', 'occurred_at', 'id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_home_recipient_unread_idx_537467f2',
        columns: ['home_id', 'recipient_membership_id', 'created_at', 'id'],
        extras: { where: '(read_at IS NULL)' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_retention_idx_e92395ef',
        columns: ['occurred_at', 'id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_source_erasure_idx_f94ef0c8',
        columns: ['home_id', 'source_entity_type', 'source_entity_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'notifications',
        index: 'notifications_source_recipient_kind_key_15fab2f3',
        columns: ['source_outbox_event_id', 'recipient_membership_id', 'kind'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'cascade',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_recipient_home_membership_fkey',
          columns: ['home_id', 'recipient_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'cascade',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_actor_membership_fkey',
          columns: ['actor_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['id'] },
          onDelete: 'setNull',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'notifications',
        foreignKey: {
          name: 'notifications_actor_home_membership_fkey',
          columns: ['home_id', 'actor_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
