import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateHomeStructureInvariant } from './structure-invariant.js';

void describe('evaluateHomeStructureInvariant', () => {
  void it('accepts ADMIN only', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [{ role: 'ADMIN' }],
      }),
      { ok: true },
    );
  });

  void it('accepts ADMIN + ROOMMATE', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [{ role: 'ADMIN' }, { role: 'ROOMMATE' }],
      }),
      { ok: true },
    );
  });

  void it('accepts ADMIN + ADMIN', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [{ role: 'ADMIN' }, { role: 'ADMIN' }],
      }),
      { ok: true },
    );
  });

  void it('rejects ROOMMATE only as integrity failure', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [{ role: 'ROOMMATE' }],
      }),
      { ok: false, reason: 'ACTIVE_HOME_WITHOUT_ADMIN' },
    );
  });

  void it('rejects ROOMMATE + ROOMMATE as integrity failure', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [{ role: 'ROOMMATE' }, { role: 'ROOMMATE' }],
      }),
      { ok: false, reason: 'ACTIVE_HOME_WITHOUT_ADMIN' },
    );
  });

  void it('treats non-archived empty active set as vacuously valid', () => {
    // Actor-bound lockHomeStructure conceals this as NOT_FOUND before
    // invariant evaluation. The implication "if count > 0 then admin >= 1"
    // does not fire. The kernel does not archive or repair.
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: false,
        activeMemberships: [],
      }),
      { ok: true },
    );
  });

  void it('does not apply the admin rule to an archived Home', () => {
    assert.deepEqual(
      evaluateHomeStructureInvariant({
        archived: true,
        activeMemberships: [{ role: 'ROOMMATE' }],
      }),
      { ok: true },
    );
  });
});
