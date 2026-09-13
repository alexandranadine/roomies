import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MaintenanceDetailProjection } from './maintenance.js';
import {
  toMaintenanceDetailDto,
  toMaintenanceListItemDto,
} from './maintenance-entry-dto.js';

const CREATED = new Date('2026-09-13T12:00:00.000Z');
const RESOLVED = new Date('2026-09-13T13:00:00.000Z');

function detail(
  overrides: Partial<MaintenanceDetailProjection> = {},
): MaintenanceDetailProjection {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    title: 'Leaky faucet',
    details: 'Under the kitchen sink',
    status: 'OPEN',
    visibility: 'PRIVATE',
    createdByMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    resolvedByMembershipId: null,
    resolvedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

void describe('Maintenance projections', () => {
  void it('whitelists the list projection without details or Home', () => {
    const dto = toMaintenanceListItemDto(detail());
    assert.deepEqual(dto, {
      id: '018f1e2c-7e3a-7000-8000-1234567890ab',
      title: 'Leaky faucet',
      status: 'OPEN',
      visibility: 'PRIVATE',
      createdByMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      resolvedByMembershipId: null,
      resolvedAt: null,
      createdAt: CREATED.toISOString(),
      updatedAt: CREATED.toISOString(),
    });
    assert.deepEqual(Object.keys(dto), [
      'id',
      'title',
      'status',
      'visibility',
      'createdByMembershipId',
      'resolvedByMembershipId',
      'resolvedAt',
      'createdAt',
      'updatedAt',
    ]);
  });

  void it('adds details only on the detail projection', () => {
    const dto = toMaintenanceDetailDto(
      detail({
        status: 'RESOLVED',
        resolvedByMembershipId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        resolvedAt: RESOLVED,
        updatedAt: RESOLVED,
      }),
    );
    assert.equal(dto.details, 'Under the kitchen sink');
    assert.equal(dto.status, 'RESOLVED');
    assert.equal(
      dto.resolvedByMembershipId,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    assert.equal(dto.resolvedAt, RESOLVED.toISOString());
  });

  void it('does not disclose Home, audience, role, or authorization fields', () => {
    const leaked = detail() as MaintenanceDetailProjection & {
      homeId: string;
      audienceMembershipIds: string[];
      userId: string;
      role: string;
      hiddenCount: number;
      canResolve: boolean;
    };
    leaked.homeId = 'home-secret';
    leaked.audienceMembershipIds = ['audience-secret'];
    leaked.userId = 'user-secret';
    leaked.role = 'ADMIN';
    leaked.hiddenCount = 2;
    leaked.canResolve = true;
    const serialized = JSON.stringify(toMaintenanceDetailDto(leaked));
    assert.equal(serialized.includes('home-secret'), false);
    assert.equal(serialized.includes('audience-secret'), false);
    assert.equal(serialized.includes('user-secret'), false);
    assert.equal(serialized.includes('homeId'), false);
    assert.equal(serialized.includes('audience'), false);
    assert.equal(serialized.includes('userId'), false);
    assert.equal(serialized.includes('hiddenCount'), false);
    assert.equal(serialized.includes('canResolve'), false);
    assert.equal(serialized.includes('"role"'), false);
  });
});
