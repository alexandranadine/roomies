#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/c9130041c9f2a4ad0e70798353eb5736c1dc6ab610a769f9465e0e23adec6b8c/contract';
import startContract from '../../snapshots/c9130041c9f2a4ad0e70798353eb5736c1dc6ab610a769f9465e0e23adec6b8c/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/d4b7887fc0824662831adc8c1debc8a09589cac57eae9cf34684b7a3e31b053d/contract';
import endContract from '../../snapshots/d4b7887fc0824662831adc8c1debc8a09589cac57eae9cf34684b7a3e31b053d/contract.json' with { type: 'json' };
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
        table: 'outbox_events',
        columns: [
          col('attempt_count', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('available_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('dead_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('event_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('event_type', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('home_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('last_error_code', 'character varying(100)', {
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 100 } },
          }),
          col('last_failed_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('lease_owner', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('lease_until', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('leased_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('occurred_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('payload', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('processed_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [
          primaryKey(['event_id']),
          checkExpression('outbox_events_attempt_count_check', '(attempt_count >= 0)'),
          checkExpression(
            'outbox_events_error_code_format_check',
            "((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[A-Z][A-Z0-9_]{0,99}$'::text))",
          ),
          checkExpression(
            'outbox_events_event_type_format_check',
            "((event_type)::text ~ '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)*[.]v[1-9][0-9]*$'::text)",
          ),
          checkExpression(
            'outbox_events_lease_completeness_check',
            '(((lease_owner IS NULL) AND (leased_at IS NULL) AND (lease_until IS NULL)) OR ((lease_owner IS NOT NULL) AND (leased_at IS NOT NULL) AND (lease_until IS NOT NULL)))',
          ),
          checkExpression(
            'outbox_events_lease_order_check',
            '((lease_until IS NULL) OR (lease_until > leased_at))',
          ),
          checkExpression(
            'outbox_events_payload_object_check',
            "(jsonb_typeof(payload) = 'object'::text)",
          ),
          checkExpression(
            'outbox_events_terminal_not_leased_check',
            '(((processed_at IS NULL) AND (dead_at IS NULL)) OR (lease_owner IS NULL))',
          ),
          checkExpression(
            'outbox_events_terminal_state_check',
            '(NOT ((processed_at IS NOT NULL) AND (dead_at IS NOT NULL)))',
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'outbox_events',
        index: 'outbox_events_claim_idx',
        columns: ['available_at', 'created_at', 'event_id'],
        extras: { where: '((processed_at IS NULL) AND (dead_at IS NULL))' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'outbox_events',
        index: 'outbox_events_dead_prune_idx',
        columns: ['dead_at', 'event_id'],
        extras: { where: '(dead_at IS NOT NULL)' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'outbox_events',
        index: 'outbox_events_processed_prune_idx',
        columns: ['processed_at', 'event_id'],
        extras: { where: '(processed_at IS NOT NULL)' },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
