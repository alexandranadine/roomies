import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { SUPPLY_ACTION } from './actions.js';
import {
  decideSupplyReleaseClaim,
  SUPPLY_RELEASE_CLAIM_CAPABLE_ROLES,
} from './release-policy.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const policyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'release-policy.ts',
);

function actor(
  role: ActiveHomeActor['role'],
  membershipId = MEMBERSHIP_A,
  homeId = HOME_A,
): Pick<ActiveHomeActor, 'homeId' | 'membershipId' | 'role'> {
  return { homeId, membershipId, role };
}

void describe('decideSupplyReleaseClaim', () => {
  void it('names the supply.release_claim action', () => {
    assert.equal(SUPPLY_ACTION.releaseClaim, 'supply.release_claim');
  });

  void it('allows only the exact claimant Membership', () => {
    assert.deepEqual(
      decideSupplyReleaseClaim({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_A,
        claimHomeId: HOME_A,
        claimantMembershipId: MEMBERSHIP_A,
      }),
      { allowed: true },
    );
    assert.deepEqual(
      decideSupplyReleaseClaim({
        actor: actor('ADMIN'),
        targetHomeId: HOME_A,
        claimHomeId: HOME_A,
        claimantMembershipId: MEMBERSHIP_A,
      }),
      { allowed: true },
    );
  });

  void it('denies a nonclaimant Roommate and a nonclaimant Admin', () => {
    assert.deepEqual(
      decideSupplyReleaseClaim({
        actor: actor('ROOMMATE', MEMBERSHIP_B),
        targetHomeId: HOME_A,
        claimHomeId: HOME_A,
        claimantMembershipId: MEMBERSHIP_A,
      }),
      { allowed: false, reason: 'SUPPLY_RELEASE_CLAIM_DENIED' },
    );
    assert.deepEqual(
      decideSupplyReleaseClaim({
        actor: actor('ADMIN', MEMBERSHIP_B),
        targetHomeId: HOME_A,
        claimHomeId: HOME_A,
        claimantMembershipId: MEMBERSHIP_A,
      }),
      { allowed: false, reason: 'SUPPLY_RELEASE_CLAIM_DENIED' },
    );
  });

  void it('denies Home and claim-Home mismatches', () => {
    assert.deepEqual(
      decideSupplyReleaseClaim({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_B,
        claimHomeId: HOME_A,
        claimantMembershipId: MEMBERSHIP_A,
      }),
      { allowed: false, reason: 'HOME_SCOPE_MISMATCH' },
    );
    assert.deepEqual(
      decideSupplyReleaseClaim({
        actor: actor('ROOMMATE'),
        targetHomeId: HOME_A,
        claimHomeId: HOME_B,
        claimantMembershipId: MEMBERSHIP_A,
      }),
      { allowed: false, reason: 'CLAIM_HOME_MISMATCH' },
    );
  });

  void it('has no Admin override or userId ownership', async () => {
    assert.deepEqual(
      [...SUPPLY_RELEASE_CLAIM_CAPABLE_ROLES],
      ['ROOMMATE', 'ADMIN'],
    );
    const source = await readFile(policyPath, 'utf8');
    assert.doesNotMatch(source, /isHomeAdmin/);
    assert.doesNotMatch(source, /actor\.userId|input\.userId/);
    assert.match(source, /actor\.membershipId !== input\.claimantMembershipId/);
  });
});
