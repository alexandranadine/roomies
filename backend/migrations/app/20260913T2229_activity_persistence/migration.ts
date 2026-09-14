#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/154a480f634392d8f058e3c55ebb272bf61dd8e322969b5abb0bd2ce11eeb916/contract';
import endContract from '../../snapshots/154a480f634392d8f058e3c55ebb272bf61dd8e322969b5abb0bd2ce11eeb916/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/29198392131d455122e9c05441c5036decaffe594b242677f6f461b9651846b9/contract';
import startContract from '../../snapshots/29198392131d455122e9c05441c5036decaffe594b242677f6f461b9651846b9/contract.json' with { type: 'json' };
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
        table: 'activities',
        columns: [
          col('actor_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('event_type', 'character varying(200)', {
            notNull: true,
            codecRef: { codecId: 'sql/varchar@1', typeParams: { length: 200 } },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('occurred_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('source_entity_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('source_entity_type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('source_outbox_event_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('visibility_class', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'activities_event_type_length_check',
            '((char_length((event_type)::text) >= 1) AND (char_length((event_type)::text) <= 200))',
          ),
          checkExpression(
            'activities_source_entity_type_check_0ee9d6e1',
            "\"source_entity_type\" IN ('MEMBERSHIP', 'TASK', 'SUPPLY', 'MAINTENANCE')",
          ),
          checkExpression(
            'activities_visibility_class_check_b3389067',
            "\"visibility_class\" IN ('HOME_VISIBLE', 'SOURCE_AUTHORIZED')",
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'activity_recipients',
        columns: [
          col('activity_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('membership_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [
          primaryKey(['home_id', 'activity_id', 'membership_id'], {
            name: 'activity_recipients_pkey',
          }),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'activities',
        index: 'activities_home_feed_idx_ac1573bd',
        columns: ['home_id', 'occurred_at', 'id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'activities',
        index: 'activities_home_id_actor_membership_id_idx_59ee34c2',
        columns: ['home_id', 'actor_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'activities',
        index: 'activities_home_id_id_key_2f2cccd8',
        columns: ['home_id', 'id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'activities',
        index: 'activities_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'activities',
        index: 'activities_source_entity_idx_cd47c954',
        columns: ['source_entity_type', 'source_entity_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'activities',
        index: 'activities_source_outbox_event_id_key_17bba872',
        columns: ['source_outbox_event_id'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'activity_recipients',
        index: 'activity_recipients_home_id_activity_id_idx_d6247ab2',
        columns: ['home_id', 'activity_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'activity_recipients',
        index: 'activity_recipients_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'activity_recipients',
        index: 'activity_recipients_home_id_membership_id_idx_3d66ba27',
        columns: ['home_id', 'membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'activity_recipients',
        index: 'activity_recipients_home_membership_activity_idx_5cd11f82',
        columns: ['home_id', 'membership_id', 'activity_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'activities',
        foreignKey: {
          name: 'activities_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'activities',
        foreignKey: {
          name: 'activities_actor_home_membership_fkey',
          columns: ['home_id', 'actor_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'activity_recipients',
        foreignKey: {
          name: 'activity_recipients_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'activity_recipients',
        foreignKey: {
          name: 'activity_recipients_activity_home_fkey',
          columns: ['home_id', 'activity_id'],
          references: { schema: 'public', table: 'activities', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'activity_recipients',
        foreignKey: {
          name: 'activity_recipients_home_membership_fkey',
          columns: ['home_id', 'membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
