#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/69b3be9ba4dff5e0aa89204a26c569bd9f59e0f750ef27f1fe7c1da04f6b5d3a/contract';
import endContract from '../../snapshots/69b3be9ba4dff5e0aa89204a26c569bd9f59e0f750ef27f1fe7c1da04f6b5d3a/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/af531590032cdd8c8c3fd02ba04f1c6a81eb78a7874402afd20497d3dca980c5/contract';
import startContract from '../../snapshots/af531590032cdd8c8c3fd02ba04f1c6a81eb78a7874402afd20497d3dca980c5/contract.json' with { type: 'json' };
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
        table: 'supply_claims',
        columns: [
          col('claimant_membership_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('claimed_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('release_reason', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('released_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('supply_entry_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'supply_claims_release_completeness_check',
            '((released_at IS NULL) = (release_reason IS NULL))',
          ),
          checkExpression(
            'supply_claims_release_reason_check_d17b2d97',
            "\"release_reason\" IN ('CLAIMANT_RELEASED', 'MEMBERSHIP_ENDED', 'ENTRY_OBTAINED', 'ENTRY_CANCELED')",
          ),
          checkExpression(
            'supply_claims_released_time_check',
            '((released_at IS NULL) OR ((released_at >= claimed_at) AND (released_at >= created_at)))',
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'supply_entries',
        columns: [
          col('canceled_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_membership_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('obtained_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
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
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'supply_entries_lifecycle_check',
            "(((status = 'OPEN'::text) AND (obtained_at IS NULL) AND (canceled_at IS NULL)) OR ((status = 'OBTAINED'::text) AND (obtained_at IS NOT NULL) AND (canceled_at IS NULL)) OR ((status = 'CANCELED'::text) AND (obtained_at IS NULL) AND (canceled_at IS NOT NULL)))",
          ),
          checkExpression(
            'supply_entries_status_check_cbe78413',
            "\"status\" IN ('OPEN', 'OBTAINED', 'CANCELED')",
          ),
          checkExpression(
            'supply_entries_terminal_time_check',
            '(((obtained_at IS NULL) OR (obtained_at >= created_at)) AND ((canceled_at IS NULL) OR (canceled_at >= created_at)))',
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_claims',
        index: 'supply_claims_entry_history_idx_8c80cae3',
        columns: ['home_id', 'supply_entry_id', 'claimed_at', 'id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_claims',
        index: 'supply_claims_home_active_claimant_idx_2b0b42e6',
        columns: ['home_id', 'claimant_membership_id', 'id'],
        extras: { where: '(released_at IS NULL)' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_claims',
        index: 'supply_claims_home_id_claimant_membership_id_idx_023e58f6',
        columns: ['home_id', 'claimant_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_claims',
        index: 'supply_claims_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_claims',
        index: 'supply_claims_home_id_supply_entry_id_idx_98811f6a',
        columns: ['home_id', 'supply_entry_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_claims',
        index: 'supply_claims_one_active_per_entry_1e26d778',
        columns: ['supply_entry_id'],
        extras: { where: '(released_at IS NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_entries',
        index: 'supply_entries_home_history_idx_60894047',
        columns: ['home_id', 'updated_at', 'id'],
        extras: { where: "(status IN ('OBTAINED', 'CANCELED'))" },
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_entries',
        index: 'supply_entries_home_id_created_by_membership_id_idx_889ed7bc',
        columns: ['home_id', 'created_by_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_entries',
        index: 'supply_entries_home_id_id_key_2f2cccd8',
        columns: ['home_id', 'id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_entries',
        index: 'supply_entries_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'supply_entries',
        index: 'supply_entries_home_open_idx_9cfca592',
        columns: ['home_id', 'created_at', 'id'],
        extras: { where: "(status = 'OPEN')" },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'supply_claims',
        foreignKey: {
          name: 'supply_claims_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'supply_claims',
        foreignKey: {
          name: 'supply_claims_entry_home_fkey',
          columns: ['home_id', 'supply_entry_id'],
          references: { schema: 'public', table: 'supply_entries', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'supply_claims',
        foreignKey: {
          name: 'supply_claims_claimant_home_membership_fkey',
          columns: ['home_id', 'claimant_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'supply_entries',
        foreignKey: {
          name: 'supply_entries_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'supply_entries',
        foreignKey: {
          name: 'supply_entries_creator_home_membership_fkey',
          columns: ['home_id', 'created_by_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
