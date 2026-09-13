import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { normalizeEmail } from '../../platform/auth/index.js';
import {
  resolveSafeDedicatedTestDatabaseUrl,
  skipUnlessDedicatedTestDatabase,
} from '../../platform/persistence/test-database.js';
import { runInReadCommittedTransaction } from '../../platform/persistence/transaction.js';
import { createInvitationRepository } from './repository.js';
import { invitationTokenHash } from './token-hash.js';

void describe('InvitationRepository PostgreSQL integration', () => {
  void it(
    'persists and loads Home-scoped invitation lifecycle rows',
    { skip: skipUnlessDedicatedTestDatabase() },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 2,
      });
      const userId = '91000000-0000-4000-8000-000000000001';
      const homeId = '92000000-0000-4000-8000-000000000001';
      const membershipId = '93000000-0000-4000-8000-000000000001';
      const invitationId = '94000000-0000-7000-8000-000000000001';
      const createdAt = new Date('2026-10-01T00:00:00.000Z');
      const expiresAt = new Date('2026-10-08T00:00:00.000Z');
      const invitedEmail = normalizeEmail('roommate+october@example.com');
      const repository = createInvitationRepository(pool);

      try {
        await pool.query(
          'INSERT INTO users (id, updated_at) VALUES ($1, now())',
          [userId],
        );
        await pool.query(
          `INSERT INTO homes (id, name, timezone, updated_at)
           VALUES ($1, 'Repository test', 'UTC', now())`,
          [homeId],
        );
        await pool.query(
          `INSERT INTO memberships (id, home_id, user_id, role)
           VALUES ($1, $2, $3, 'ADMIN')`,
          [membershipId, homeId, userId],
        );
        await runInReadCommittedTransaction(pool, (tx) =>
          repository.insert(tx, {
            id: invitationId,
            homeId,
            invitedEmail,
            tokenHash: invitationTokenHash(new Uint8Array(32).fill(11)),
            createdByMembershipId: membershipId,
            createdAt,
            expiresAt,
          }),
        );

        const loaded = await repository.findByPublicId(homeId, invitationId);
        assert.equal(loaded?.id, invitationId);
        assert.equal(loaded?.invitedEmail, invitedEmail);
        assert.equal(loaded?.tokenHash.byteLength, 32);

        const byId = await repository.findById(invitationId);
        assert.equal(byId?.id, invitationId);
        assert.equal(byId?.homeId, homeId);
        assert.equal(byId?.invitedEmail, invitedEmail);
        assert.equal(
          await repository.findById('95000000-0000-7000-8000-000000000099'),
          null,
        );

        await runInReadCommittedTransaction(pool, async (tx) => {
          const effective = await repository.findEffectivePending(tx, {
            homeId,
            invitedEmail,
            at: new Date('2026-10-02T00:00:00.000Z'),
          });
          assert.equal(effective?.id, invitationId);

          const locked = await repository.lockById(tx, {
            homeId,
            invitationId,
          });
          assert.equal(locked?.id, invitationId);

          const archiveRows = await repository.lockOpenForHomeArchive(tx, {
            homeId,
            at: expiresAt,
          });
          assert.deepEqual(
            archiveRows.map((row) => [row.invitation.id, row.lifecycle]),
            [[invitationId, 'EXPIRED']],
          );
        });
      } finally {
        await pool.query('DELETE FROM invitations WHERE id = $1', [
          invitationId,
        ]);
        await pool.query('DELETE FROM memberships WHERE id = $1', [
          membershipId,
        ]);
        await pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await pool.end();
      }
    },
  );

  void it(
    'revokes a locked pending invitation with ADMIN_REVOKED once',
    { skip: skipUnlessDedicatedTestDatabase() },
    async () => {
      const pool = new Pool({
        connectionString: resolveSafeDedicatedTestDatabaseUrl(),
        max: 2,
      });
      const userId = '91000000-0000-4000-8000-000000000002';
      const homeId = '92000000-0000-4000-8000-000000000002';
      const otherHomeId = '92000000-0000-4000-8000-000000000099';
      const membershipId = '93000000-0000-4000-8000-000000000002';
      const invitationId = '94000000-0000-7000-8000-000000000002';
      const createdAt = new Date('2026-10-01T00:00:00.000Z');
      const expiresAt = new Date('2026-10-08T00:00:00.000Z');
      const revokedAt = new Date('2026-10-02T00:00:00.000Z');
      const invitedEmail = normalizeEmail('roommate+revoke@example.com');
      const repository = createInvitationRepository(pool);

      try {
        await pool.query(
          'INSERT INTO users (id, updated_at) VALUES ($1, now())',
          [userId],
        );
        await pool.query(
          `INSERT INTO homes (id, name, timezone, updated_at)
           VALUES ($1, 'Revoke repository test', 'UTC', now())`,
          [homeId],
        );
        await pool.query(
          `INSERT INTO memberships (id, home_id, user_id, role)
           VALUES ($1, $2, $3, 'ADMIN')`,
          [membershipId, homeId, userId],
        );
        await runInReadCommittedTransaction(pool, (tx) =>
          repository.insert(tx, {
            id: invitationId,
            homeId,
            invitedEmail,
            tokenHash: invitationTokenHash(new Uint8Array(32).fill(12)),
            createdByMembershipId: membershipId,
            createdAt,
            expiresAt,
          }),
        );

        const first = await runInReadCommittedTransaction(pool, async (tx) => {
          const locked = await repository.lockById(tx, {
            homeId,
            invitationId,
          });
          assert.equal(locked?.revokedAt, null);
          const updated = await repository.revokeLocked(tx, {
            invitationId,
            homeId,
            revokedAt,
            cause: 'ADMIN_REVOKED',
          });
          const crossHome = await repository.revokeLocked(tx, {
            invitationId,
            homeId: otherHomeId,
            revokedAt,
            cause: 'ADMIN_REVOKED',
          });
          return { updated, crossHome };
        });
        assert.equal(first.updated, 1);
        assert.equal(first.crossHome, 0);

        const loaded = await repository.findByPublicId(homeId, invitationId);
        assert.deepEqual(loaded?.revokedAt, revokedAt);
        assert.equal(loaded?.revocationCause, 'ADMIN_REVOKED');
        assert.equal(loaded?.acceptedAt, null);
        assert.equal(loaded?.createdByMembershipId, membershipId);
        assert.deepEqual(loaded?.createdAt, createdAt);
        assert.deepEqual(loaded?.expiresAt, expiresAt);

        const second = await runInReadCommittedTransaction(pool, (tx) =>
          repository.revokeLocked(tx, {
            invitationId,
            homeId,
            revokedAt: new Date('2026-10-03T00:00:00.000Z'),
            cause: 'ADMIN_REVOKED',
          }),
        );
        assert.equal(second, 0);
        const unchanged = await repository.findByPublicId(homeId, invitationId);
        assert.deepEqual(unchanged?.revokedAt, revokedAt);
      } finally {
        await pool.query('DELETE FROM invitations WHERE id = $1', [
          invitationId,
        ]);
        await pool.query('DELETE FROM memberships WHERE id = $1', [
          membershipId,
        ]);
        await pool.query('DELETE FROM homes WHERE id = $1', [homeId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        await pool.end();
      }
    },
  );
});
