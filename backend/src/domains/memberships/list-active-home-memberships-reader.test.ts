import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import {
  createActiveHomeMembershipsReader,
  LIST_ACTIVE_HOME_MEMBERSHIPS_SQL,
  type ActiveHomeMembershipsQueryable,
} from './list-active-home-memberships-reader.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

void describe('LIST_ACTIVE_HOME_MEMBERSHIPS_SQL', () => {
  void it('lists only current active same-Home Memberships with AuthIdentity name', () => {
    assert.match(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /m\.home_id = \$1::uuid/);
    assert.match(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /m\.ended_at IS NULL/);
    assert.match(
      LIST_ACTIVE_HOME_MEMBERSHIPS_SQL,
      /INNER JOIN auth_identities AS i/,
    );
    assert.match(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /i\.id = m\.user_id/);
    assert.match(
      LIST_ACTIVE_HOME_MEMBERSHIPS_SQL,
      /ORDER BY i\.name ASC, m\.id ASC/,
    );
    assert.doesNotMatch(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /invitations/i);
    assert.doesNotMatch(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /\bemail\b/);
    assert.doesNotMatch(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /\brole\b/);
    assert.doesNotMatch(
      LIST_ACTIVE_HOME_MEMBERSHIPS_SQL,
      /ended_at IS NOT NULL/,
    );
    assert.doesNotMatch(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /joined_at/);
    assert.doesNotMatch(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /FOR UPDATE/i);
    assert.match(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /m\.id AS membership_id/);
    assert.match(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /i\.name AS name/);
    assert.doesNotMatch(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /user_id AS/);
    assert.doesNotMatch(LIST_ACTIVE_HOME_MEMBERSHIPS_SQL, /m\.user_id,/);
  });
});

void describe('createActiveHomeMembershipsReader', () => {
  void it('maps ordered rows without application-side filtering', async () => {
    const calls: { text: string; values: readonly unknown[] | undefined }[] =
      [];
    const queryable: ActiveHomeMembershipsQueryable = {
      query<T>(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        return Promise.resolve({
          rows: [
            { membership_id: MEMBERSHIP_A, name: 'Alex' },
            { membership_id: MEMBERSHIP_B, name: 'Jamie' },
          ] as T[],
        });
      },
    };
    const reader = createActiveHomeMembershipsReader(queryable);

    const listed = await reader.listActiveByHome(HOME);
    assert.deepEqual(listed, [
      { membershipId: MEMBERSHIP_A, name: 'Alex' },
      { membershipId: MEMBERSHIP_B, name: 'Jamie' },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.text, LIST_ACTIVE_HOME_MEMBERSHIPS_SQL);
    assert.deepEqual(calls[0]?.values, [HOME]);
  });

  void it('returns an empty list when the Home has no active Memberships', async () => {
    const queryable: ActiveHomeMembershipsQueryable = {
      query<T>() {
        return Promise.resolve({ rows: [] as T[] });
      },
    };
    const reader = createActiveHomeMembershipsReader(queryable);
    assert.deepEqual(await reader.listActiveByHome(HOME), []);
  });

  void it('fails closed on a malformed Home id without querying', async () => {
    const reader = createActiveHomeMembershipsReader({
      query: () => Promise.reject(new Error('must not query')),
    });
    await assert.rejects(
      () => reader.listActiveByHome('not-a-uuid'),
      AuthorizationIntegrityError,
    );
  });

  void it('fails closed on duplicate, empty-name, or malformed rows', async () => {
    const duplicate: ActiveHomeMembershipsQueryable = {
      query<T>() {
        return Promise.resolve({
          rows: [
            { membership_id: MEMBERSHIP_A, name: 'Alex' },
            { membership_id: MEMBERSHIP_A, name: 'Alex' },
          ] as T[],
        });
      },
    };
    await assert.rejects(
      () => createActiveHomeMembershipsReader(duplicate).listActiveByHome(HOME),
      AuthorizationIntegrityError,
    );

    const emptyName: ActiveHomeMembershipsQueryable = {
      query<T>() {
        return Promise.resolve({
          rows: [{ membership_id: MEMBERSHIP_A, name: '' }] as T[],
        });
      },
    };
    await assert.rejects(
      () => createActiveHomeMembershipsReader(emptyName).listActiveByHome(HOME),
      AuthorizationIntegrityError,
    );

    const malformed: ActiveHomeMembershipsQueryable = {
      query<T>() {
        return Promise.resolve({
          rows: [{ membership_id: 'nope', name: 'Alex' }] as T[],
        });
      },
    };
    await assert.rejects(
      () => createActiveHomeMembershipsReader(malformed).listActiveByHome(HOME),
      AuthorizationIntegrityError,
    );
  });

  void it('fails closed when the lookup throws', async () => {
    const reader = createActiveHomeMembershipsReader({
      query: () => Promise.reject(new Error('lookup failed')),
    });
    await assert.rejects(
      () => reader.listActiveByHome(HOME),
      AuthorizationIntegrityError,
    );
  });
});
