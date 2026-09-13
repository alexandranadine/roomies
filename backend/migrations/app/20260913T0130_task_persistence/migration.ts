#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/5a23f336d31a17bd850ac723ec043a74a198135eb678d527b560f1cc53baa7dc/contract';
import startContract from '../../snapshots/5a23f336d31a17bd850ac723ec043a74a198135eb678d527b560f1cc53baa7dc/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/64d43d201edd6675c3b3665ec0c764020e54aff2ff974646026e0eeaedbdb534/contract';
import endContract from '../../snapshots/64d43d201edd6675c3b3665ec0c764020e54aff2ff974646026e0eeaedbdb534/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'task_definitions',
        columns: [
          col('assigned_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('creator_membership_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('deactivated_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('next_occurrence_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('recurrence_day_of_month', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('recurrence_frequency', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('recurrence_weekday', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'task_definitions_deactivated_time_check',
            '((deactivated_at IS NULL) OR (deactivated_at >= created_at))',
          ),
          checkExpression(
            'task_definitions_recurrence_config_check',
            "(((recurrence_frequency = 'DAILY'::text) AND (recurrence_weekday IS NULL) AND (recurrence_day_of_month IS NULL)) OR ((recurrence_frequency = 'WEEKLY'::text) AND (recurrence_weekday IS NOT NULL) AND ((recurrence_weekday >= 1) AND (recurrence_weekday <= 7)) AND (recurrence_day_of_month IS NULL)) OR ((recurrence_frequency = 'MONTHLY'::text) AND (recurrence_weekday IS NULL) AND (recurrence_day_of_month IS NOT NULL) AND ((recurrence_day_of_month >= 1) AND (recurrence_day_of_month <= 31))))",
          ),
          checkExpression(
            'task_definitions_recurrence_frequency_check_979d6261',
            "\"recurrence_frequency\" IN ('DAILY', 'WEEKLY', 'MONTHLY')",
          ),
          checkExpression(
            'task_definitions_scheduling_lifecycle_check',
            '((deactivated_at IS NULL) = (next_occurrence_at IS NOT NULL))',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'task_instances',
        columns: [
          col('assigned_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('completed_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('scheduled_for', 'date', { codecRef: { codecId: 'pg/date-string@1' } }),
          col('source', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('OPEN'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('task_definition_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'task_instances_completed_time_check',
            '((completed_at IS NULL) OR (completed_at >= created_at))',
          ),
          checkExpression(
            'task_instances_completion_state_check',
            "(((status = 'OPEN'::text) AND (completed_at IS NULL)) OR ((status = 'COMPLETED'::text) AND (completed_at IS NOT NULL)))",
          ),
          checkExpression(
            'task_instances_source_check_2dc6a827',
            "\"source\" IN ('MANUAL', 'RECURRING')",
          ),
          checkExpression(
            'task_instances_source_definition_check',
            "(((source = 'MANUAL'::text) AND (task_definition_id IS NULL)) OR ((source = 'RECURRING'::text) AND (task_definition_id IS NOT NULL) AND (scheduled_for IS NOT NULL)))",
          ),
          checkExpression(
            'task_instances_status_check_6df9db95',
            "\"status\" IN ('OPEN', 'COMPLETED')",
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_definitions',
        index: 'task_definitions_home_active_assignee_idx_573b0e84',
        columns: ['home_id', 'assigned_membership_id', 'id'],
        extras: { where: '((deactivated_at IS NULL) AND (assigned_membership_id IS NOT NULL))' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_definitions',
        index: 'task_definitions_home_active_idx_db669dcd',
        columns: ['home_id', 'created_at', 'id'],
        extras: { where: '(deactivated_at IS NULL)' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_definitions',
        index: 'task_definitions_home_creator_idx_ac77ea12',
        columns: ['home_id', 'creator_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_definitions',
        index: 'task_definitions_home_id_assigned_membership_id_idx_8e6c14e4',
        columns: ['home_id', 'assigned_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_definitions',
        index: 'task_definitions_home_id_id_key_2f2cccd8',
        columns: ['home_id', 'id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_definitions',
        index: 'task_definitions_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_definitions',
        index: 'task_definitions_worker_due_idx_3a11af30',
        columns: ['next_occurrence_at', 'id'],
        extras: { where: '(deactivated_at IS NULL)' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_instances',
        index: 'task_instances_definition_occurrence_uidx_0046b96b',
        columns: ['task_definition_id', 'scheduled_for'],
        extras: { where: '(task_definition_id IS NOT NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_instances',
        index: 'task_instances_home_completed_idx_cb8f99ae',
        columns: ['home_id', 'completed_at', 'id'],
        extras: { where: "(status = 'COMPLETED')" },
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_instances',
        index: 'task_instances_home_id_assigned_membership_id_idx_8e6c14e4',
        columns: ['home_id', 'assigned_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_instances',
        index: 'task_instances_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_instances',
        index: 'task_instances_home_id_task_definition_id_idx_5ae5c128',
        columns: ['home_id', 'task_definition_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_instances',
        index: 'task_instances_home_open_assignee_idx_cf14ba37',
        columns: ['home_id', 'assigned_membership_id', 'id'],
        extras: { where: "((status = 'OPEN') AND (assigned_membership_id IS NOT NULL))" },
      }),
      this.createIndex({
        schema: 'public',
        table: 'task_instances',
        index: 'task_instances_home_open_idx_6e659718',
        columns: ['home_id', 'scheduled_for', 'created_at', 'id'],
        extras: { where: "(status = 'OPEN')" },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_definitions',
        foreignKey: {
          name: 'task_definitions_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_definitions',
        foreignKey: {
          name: 'task_definitions_assigned_home_membership_fkey',
          columns: ['home_id', 'assigned_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_definitions',
        foreignKey: {
          name: 'task_definitions_creator_home_membership_fkey',
          columns: ['home_id', 'creator_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_instances',
        foreignKey: {
          name: 'task_instances_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_instances',
        foreignKey: {
          name: 'task_instances_assigned_home_membership_fkey',
          columns: ['home_id', 'assigned_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'task_instances',
        foreignKey: {
          name: 'task_instances_definition_home_fkey',
          columns: ['home_id', 'task_definition_id'],
          references: { schema: 'public', table: 'task_definitions', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
