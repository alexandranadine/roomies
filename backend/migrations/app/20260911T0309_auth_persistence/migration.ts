#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/b024885b9498e1596c5d1c2c70179e7c887fe4d25fe33005237a212c94a4e62e/contract';
import startContract from '../../snapshots/b024885b9498e1596c5d1c2c70179e7c887fe4d25fe33005237a212c94a4e62e/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/c9130041c9f2a4ad0e70798353eb5736c1dc6ab610a769f9465e0e23adec6b8c/contract';
import endContract from '../../snapshots/c9130041c9f2a4ad0e70798353eb5736c1dc6ab610a769f9465e0e23adec6b8c/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  fn,
  lit,
  primaryKey,
  rawSql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'auth_accounts',
        columns: [
          col('access_token', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('access_token_expires_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('account_id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('id_token', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('password', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('provider_id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('refresh_token', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('refresh_token_expires_at', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('scope', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('user_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'auth_identities',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('email_verified', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('image', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'auth_sessions',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('expires_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('ip_address', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('token', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('user_agent', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('user_id', 'uuid', { notNull: true, codecRef: { codecId: 'pg/uuid@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'auth_verifications',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('expires_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'uuid', {
            notNull: true,
            default: fn('gen_random_uuid()'),
            codecRef: { codecId: 'pg/uuid@1' },
          }),
          col('identifier', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('value', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      rawSql({
        id: 'function.public.provision_user_for_auth_identity',
        label: 'Create auth identity canonical User provisioning function',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [
          {
            description: 'ensure provisioning function does not exist',
            sql: `SELECT to_regprocedure($1) IS NULL AS "result"`,
            params: ['public.provision_user_for_auth_identity()'],
          },
        ],
        execute: [
          {
            description: 'create canonical User provisioning function',
            sql: `CREATE FUNCTION public.provision_user_for_auth_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  INSERT INTO public.users (id, updated_at)
  VALUES (NEW.id, CURRENT_TIMESTAMP);

  RETURN NEW;
END;
$function$`,
            params: [],
          },
        ],
        postcheck: [
          {
            description: 'verify canonical User provisioning function contract',
            sql: `SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_proc AS p
  INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  INNER JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname = 'provision_user_for_auth_identity'
    AND p.pronargs = 0
    AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    AND p.prosecdef = false
    AND l.lanname = 'plpgsql'
    AND COALESCE(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog']
    AND POSITION(
      'insert into public.users (id, updated_at) values (new.id, current_timestamp);'
      IN pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:]]+', ' ', 'g')
    ) > 0
    AND POSITION(
      'return new;'
      IN pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:]]+', ' ', 'g')
    ) > 0
    AND POSITION('on conflict' IN pg_catalog.lower(p.prosrc)) = 0
    AND POSITION('exception' IN pg_catalog.lower(p.prosrc)) = 0
) AS "result"`,
            params: [],
          },
        ],
      }),
      rawSql({
        id: 'trigger.public.auth_identities.auth_identities_provision_user',
        label: 'Create auth identity canonical User provisioning trigger',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [
          {
            description: 'ensure trigger is absent and provisioning function exists',
            sql: `SELECT (
  to_regprocedure($1) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS t
    WHERE t.tgrelid = to_regclass($2)
      AND t.tgname = $3
  )
) AS "result"`,
            params: [
              'public.provision_user_for_auth_identity()',
              'public.auth_identities',
              'auth_identities_provision_user',
            ],
          },
        ],
        execute: [
          {
            description: 'create canonical User provisioning trigger',
            sql: `CREATE TRIGGER auth_identities_provision_user
BEFORE INSERT
ON public.auth_identities
FOR EACH ROW
EXECUTE FUNCTION public.provision_user_for_auth_identity()`,
            params: [],
          },
        ],
        postcheck: [
          {
            description: 'verify provisioning trigger catalog contract',
            sql: `SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_trigger AS t
  WHERE t.tgrelid = to_regclass('public.auth_identities')
    AND t.tgname = 'auth_identities_provision_user'
    AND t.tgenabled = 'O'
    AND t.tgisinternal = false
    AND t.tgtype = 7
    AND t.tgfoid = to_regprocedure('public.provision_user_for_auth_identity()')
) AS "result"`,
            params: [],
          },
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'auth_accounts',
        index: 'auth_accounts_user_id_idx_6c952402',
        columns: ['user_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'auth_identities',
        index: 'auth_identities_email_uidx_34912d96',
        columns: ['email'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'auth_sessions',
        index: 'auth_sessions_token_uidx_62c1af9d',
        columns: ['token'],
        extras: { unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'auth_sessions',
        index: 'auth_sessions_user_id_idx_6c952402',
        columns: ['user_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'auth_verifications',
        index: 'auth_verifications_identifier_idx_79a0dbb3',
        columns: ['identifier'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'auth_accounts',
        foreignKey: {
          name: 'auth_accounts_user_id_fkey',
          columns: ['user_id'],
          references: { schema: 'public', table: 'auth_identities', columns: ['id'] },
          onDelete: 'cascade',
          onUpdate: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'auth_identities',
        foreignKey: {
          name: 'auth_identities_id_fkey',
          columns: ['id'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'restrict',
          onUpdate: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'auth_sessions',
        foreignKey: {
          name: 'auth_sessions_user_id_fkey',
          columns: ['user_id'],
          references: { schema: 'public', table: 'auth_identities', columns: ['id'] },
          onDelete: 'cascade',
          onUpdate: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
