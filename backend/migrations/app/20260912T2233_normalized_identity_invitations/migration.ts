#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/5a23f336d31a17bd850ac723ec043a74a198135eb678d527b560f1cc53baa7dc/contract';
import endContract from '../../snapshots/5a23f336d31a17bd850ac723ec043a74a198135eb678d527b560f1cc53baa7dc/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/d4b7887fc0824662831adc8c1debc8a09589cac57eae9cf34684b7a3e31b053d/contract';
import startContract from '../../snapshots/d4b7887fc0824662831adc8c1debc8a09589cac57eae9cf34684b7a3e31b053d/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  primaryKey,
  rawSql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'data.public.auth_identities.normalize_canonical_email',
        label: 'Audit and normalize canonical auth identity emails',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [
          {
            description: 'refuse normalized collisions or unsupported stored email values',
            sql: `SELECT (
  NOT EXISTS (
    SELECT 1
    FROM public.auth_identities
    GROUP BY pg_catalog.lower(pg_catalog.btrim(email))
    HAVING COUNT(*) > 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.auth_identities
    WHERE pg_catalog.char_length(pg_catalog.lower(pg_catalog.btrim(email))) NOT BETWEEN 3 AND 254
       OR pg_catalog.lower(pg_catalog.btrim(email)) !~ '^[!-~]+$'::text
  )
) AS "result"`,
            params: [],
          },
        ],
        execute: [
          {
            description: 'store every auth email in canonical form',
            sql: `UPDATE public.auth_identities
SET email = pg_catalog.lower(pg_catalog.btrim(email))
WHERE email IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(email))`,
            params: [],
          },
        ],
        postcheck: [
          {
            description: 'verify canonical auth email storage and uniqueness',
            sql: `SELECT (
  NOT EXISTS (
    SELECT 1
    FROM public.auth_identities
    WHERE email IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(email))
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.auth_identities
    GROUP BY email
    HAVING COUNT(*) > 1
  )
) AS "result"`,
            params: [],
          },
        ],
      }),
      rawSql({
        id: 'extension.public.btree_gist',
        label: 'Install btree_gist for invitation temporal exclusion',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [
          {
            description: 'allow idempotent btree_gist extension installation',
            sql: `SELECT true AS "result"`,
            params: [],
          },
        ],
        execute: [
          {
            description: 'install btree_gist extension',
            sql: `CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public`,
            params: [],
          },
        ],
        postcheck: [
          {
            description: 'verify btree_gist is installed',
            sql: `SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_extension
  WHERE extname = 'btree_gist'
) AS "result"`,
            params: [],
          },
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'invitations',
        columns: [
          col('accepted_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('accepted_membership_id', 'uuid', { codecRef: { codecId: 'pg/uuid@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('created_by_membership_id', 'uuid', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('expires_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('home_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
          col('invited_email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revocation_cause', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('revoked_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('token_hash', 'bytea', { notNull: true, codecRef: { codecId: 'pg/bytea@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'invitations_acceptance_completeness_check',
            '((accepted_at IS NULL) = (accepted_membership_id IS NULL))',
          ),
          checkExpression(
            'invitations_accepted_time_check',
            '((accepted_at IS NULL) OR ((accepted_at >= created_at) AND (accepted_at < expires_at)))',
          ),
          checkExpression(
            'invitations_email_canonical_check',
            "((char_length(invited_email) >= 3) AND (char_length(invited_email) <= 254) AND (invited_email = btrim(invited_email)) AND (invited_email !~ '[A-Z]'::text) AND (invited_email ~ '^[!-~]+$'::text))",
          ),
          checkExpression('invitations_expiry_order_check', '(expires_at > created_at)'),
          checkExpression(
            'invitations_revocation_cause_check',
            "((revocation_cause IS NULL) OR (revocation_cause = ANY (ARRAY['ADMIN_REVOKED'::text, 'HOME_ARCHIVED'::text])))",
          ),
          checkExpression(
            'invitations_revocation_completeness_check',
            '((revoked_at IS NULL) = (revocation_cause IS NULL))',
          ),
          checkExpression(
            'invitations_revoked_time_check',
            '((revoked_at IS NULL) OR ((revoked_at >= created_at) AND (revoked_at < expires_at)))',
          ),
          checkExpression(
            'invitations_terminal_state_check',
            '(NOT ((accepted_at IS NOT NULL) AND (revoked_at IS NOT NULL)))',
          ),
          checkExpression('invitations_token_hash_length_check', '(octet_length(token_hash) = 32)'),
        ],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'auth_identities',
        constraint: 'auth_identities_email_canonical_check',
        expression:
          "((char_length(email) >= 3) AND (char_length(email) <= 254) AND (email = btrim(email)) AND (email !~ '[A-Z]'::text) AND (email ~ '^[!-~]+$'::text))",
      }),
      this.createIndex({
        schema: 'public',
        table: 'invitations',
        index: 'invitations_accepted_membership_uidx_b563a30a',
        columns: ['accepted_membership_id'],
        extras: { where: '(accepted_membership_id IS NOT NULL)', unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'invitations',
        index: 'invitations_created_by_membership_idx_48d99df3',
        columns: ['created_by_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'invitations',
        index: 'invitations_home_id_accepted_membership_id_idx_48aa0859',
        columns: ['home_id', 'accepted_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'invitations',
        index: 'invitations_home_id_created_by_membership_id_idx_889ed7bc',
        columns: ['home_id', 'created_by_membership_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'invitations',
        index: 'invitations_home_id_idx_f881d5c1',
        columns: ['home_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'invitations',
        index: 'invitations_home_open_idx_585413c4',
        columns: ['home_id', 'expires_at', 'created_at', 'id'],
        extras: { where: '((accepted_at IS NULL) AND (revoked_at IS NULL))' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'invitations',
        index: 'invitations_token_hash_uidx_caa64aca',
        columns: ['token_hash'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'memberships',
        index: 'memberships_home_id_id_key_2f2cccd8',
        columns: ['home_id', 'id'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'invitations',
        foreignKey: {
          name: 'invitations_home_id_fkey',
          columns: ['home_id'],
          references: { schema: 'public', table: 'homes', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'invitations',
        foreignKey: {
          name: 'invitations_creator_home_membership_fkey',
          columns: ['home_id', 'created_by_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'invitations',
        foreignKey: {
          name: 'invitations_accepted_home_membership_fkey',
          columns: ['home_id', 'accepted_membership_id'],
          references: { schema: 'public', table: 'memberships', columns: ['home_id', 'id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      rawSql({
        id: 'constraint.public.invitations.invitations_nonoverlapping_validity',
        label: 'Prevent overlapping effective invitation validity',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [
          {
            description: 'ensure invitation validity exclusion constraint is absent',
            sql: `SELECT NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.invitations'::pg_catalog.regclass
    AND conname = 'invitations_nonoverlapping_validity'
) AS "result"`,
            params: [],
          },
        ],
        execute: [
          {
            description: 'add invitation effective-validity exclusion constraint',
            sql: `ALTER TABLE public.invitations
ADD CONSTRAINT invitations_nonoverlapping_validity
EXCLUDE USING gist (
  home_id WITH =,
  invited_email WITH =,
  tstzrange(
    created_at,
    COALESCE(accepted_at, revoked_at, expires_at),
    '[)'::text
  ) WITH &&
)`,
            params: [],
          },
        ],
        postcheck: [
          {
            description: 'verify invitation validity exclusion constraint',
            sql: `SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.invitations'::pg_catalog.regclass
    AND conname = 'invitations_nonoverlapping_validity'
    AND contype = 'x'
) AS "result"`,
            params: [],
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
