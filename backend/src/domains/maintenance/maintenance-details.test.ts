import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidMaintenanceDetailsError } from './errors.js';
import {
  MAINTENANCE_DETAILS_MAX_LENGTH,
  normalizeMaintenanceDetails,
} from './maintenance-details.js';

void describe('normalizeMaintenanceDetails', () => {
  void it('trims Unicode text and preserves internal whitespace', () => {
    assert.equal(
      normalizeMaintenanceDetails('  Behind the fridge  '),
      'Behind the fridge',
    );
    assert.equal(normalizeMaintenanceDetails('  Café 家  '), 'Café 家');
  });

  void it('normalizes missing and empty-after-trim details to null', () => {
    assert.equal(normalizeMaintenanceDetails(null), null);
    assert.equal(normalizeMaintenanceDetails(undefined), null);
    assert.equal(normalizeMaintenanceDetails(''), null);
    assert.equal(normalizeMaintenanceDetails('   '), null);
    assert.equal(normalizeMaintenanceDetails('\n\t'), null);
  });

  void it('rejects overlong details without truncating', () => {
    const max = 'x'.repeat(MAINTENANCE_DETAILS_MAX_LENGTH);
    const overlong = 'x'.repeat(MAINTENANCE_DETAILS_MAX_LENGTH + 1);
    assert.equal(normalizeMaintenanceDetails(max), max);
    assert.throws(
      () => normalizeMaintenanceDetails(overlong),
      InvalidMaintenanceDetailsError,
    );
    assert.equal(overlong.length, MAINTENANCE_DETAILS_MAX_LENGTH + 1);
    assert.equal(MAINTENANCE_DETAILS_MAX_LENGTH, 4000);
  });
});
