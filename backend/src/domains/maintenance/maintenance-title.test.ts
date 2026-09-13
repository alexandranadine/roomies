import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidMaintenanceTitleError } from './errors.js';
import {
  MAINTENANCE_TITLE_MAX_LENGTH,
  normalizeMaintenanceTitle,
} from './maintenance-title.js';

void describe('normalizeMaintenanceTitle', () => {
  void it('trims surrounding whitespace and preserves internal Unicode text', () => {
    assert.equal(normalizeMaintenanceTitle('  Leaky faucet  '), 'Leaky faucet');
    assert.equal(normalizeMaintenanceTitle('  Café 家  '), 'Café 家');
    assert.equal(normalizeMaintenanceTitle('Hot  water'), 'Hot  water');
  });

  void it('rejects empty and whitespace-only titles without truncating', () => {
    assert.throws(
      () => normalizeMaintenanceTitle(''),
      InvalidMaintenanceTitleError,
    );
    assert.throws(
      () => normalizeMaintenanceTitle('   '),
      InvalidMaintenanceTitleError,
    );
    assert.throws(
      () => normalizeMaintenanceTitle('\n\t'),
      InvalidMaintenanceTitleError,
    );
  });

  void it('rejects overlong titles without truncating', () => {
    const max = 'x'.repeat(MAINTENANCE_TITLE_MAX_LENGTH);
    const overlong = 'x'.repeat(MAINTENANCE_TITLE_MAX_LENGTH + 1);
    assert.equal(normalizeMaintenanceTitle(max), max);
    assert.throws(
      () => normalizeMaintenanceTitle(overlong),
      InvalidMaintenanceTitleError,
    );
    assert.equal(overlong.length, MAINTENANCE_TITLE_MAX_LENGTH + 1);
    assert.equal(MAINTENANCE_TITLE_MAX_LENGTH, 120);
  });
});
