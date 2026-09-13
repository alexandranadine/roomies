#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/29198392131d455122e9c05441c5036decaffe594b242677f6f461b9651846b9/contract';
import endContract from '../../snapshots/29198392131d455122e9c05441c5036decaffe594b242677f6f461b9651846b9/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/69b3be9ba4dff5e0aa89204a26c569bd9f59e0f750ef27f1fe7c1da04f6b5d3a/contract';
import startContract from '../../snapshots/69b3be9ba4dff5e0aa89204a26c569bd9f59e0f750ef27f1fe7c1da04f6b5d3a/contract.json' with { type: 'json' };
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
        table: 'maintenance_audiences',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('maintenance_entry_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('membership_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['home_id', 'maintenance_entry_id', 'membership_id'], {
            name: 'maintenance_audiences_pkey',
          }),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'maintenance_entries',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_membership_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('details', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('resolved_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('resolved_by_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('OPEN'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('visibility', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'maintenance_entries_details_canonical_check',
            '((details IS NULL) OR ((char_length(details) >= 1) AND (char_length(details) <= 4000) AND (details = btrim(details))))',
          ),
          checkExpression(
            'maintenance_entries_lifecycle_check',
            "(((status = 'OPEN'::text) AND (resolved_by_membership_id IS NULL) AND (resolved_at IS NULL)) OR ((status = 'RESOLVED'::text) AND (resolved_by_membership_id IS NOT NULL) AND (resolved_at IS NOT NULL)))",
          ),
          checkExpression(
            'maintenance_entries_resolved_time_check',
            '((resolved_at IS NULL) OR ((resolved_at >= created_at) AND (resolved_at <= updated_at)))',
          ),
          checkExpression(
            'maintenance_entries_status_check_2a206a64',
            "\"status\" IN ('OPEN', 'RESOLVED')",
          ),
          checkExpression(
            'maintenance_entries_title_canonical_check',
            '((char_length(title) >= 1) AND (char_length(title) <= 120) AND (title = btrim(title)))',
          ),
          checkExpression('maintenance_entries_updated_time_check', '(updated_at >= created_at)'),
          checkExpression(
            'maintenance_entries_visibility_check_b1f71ccd',
            "\"visibility\" IN ('HOUSEHOLD', 'PRIVATE')",
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_audiences',
        index: 'maintenance_audiences_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_audiences',
        index: 'maintenance_audiences_home_id_maintenance_entry_id_idx_07136f46',
        columns: ['home_id', 'maintenance_entry_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_audiences',
        index: 'maintenance_audiences_home_id_membership_id_idx_3d66ba27',
        columns: ['home_id', 'membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_audiences',
        index: 'maintenance_audiences_home_membership_entry_idx_478378c9',
        columns: ['home_id', 'membership_id', 'maintenance_entry_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_entries',
        index: 'maintenance_entries_home_id_created_by_membership_id_i_889ed7bc',
        columns: ['home_id', 'created_by_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_entries',
        index: 'maintenance_entries_home_id_id_key_2f2cccd8',
        columns: ['home_id', 'id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_entries',
        index: 'maintenance_entries_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_entries',
        index: 'maintenance_entries_home_id_resolved_by_membership_id__4c1f3348',
        columns: ['home_id', 'resolved_by_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_entries',
        index: 'maintenance_entries_home_open_idx_9084003b',
        columns: ['home_id', 'updated_at', 'id'],
        extras: { where: "(status = 'OPEN')" },
      }),
      this.createIndex({
        schema: 'public',
        table: 'maintenance_entries',
        index: 'maintenance_entries_home_resolved_idx_af0912c3',
        columns: ['home_id', 'updated_at', 'id'],
        extras: { where: "(status = 'RESOLVED')" },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'maintenance_audiences',
        foreignKey: {
          name: 'maintenance_audiences_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'maintenance_audiences',
        foreignKey: {
          name: 'maintenance_audiences_entry_home_fkey',
          columns: ['home_id', 'maintenance_entry_id'],
          references: {
            schema: 'public',
            table: 'maintenance_entries',
            columns: ['home_id', 'id'],
          },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'maintenance_audiences',
        foreignKey: {
          name: 'maintenance_audiences_home_membership_fkey',
          columns: ['home_id', 'membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'maintenance_entries',
        foreignKey: {
          name: 'maintenance_entries_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'maintenance_entries',
        foreignKey: {
          name: 'maintenance_entries_creator_home_membership_fkey',
          columns: ['home_id', 'created_by_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'maintenance_entries',
        foreignKey: {
          name: 'maintenance_entries_resolver_home_membership_fkey',
          columns: ['home_id', 'resolved_by_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
