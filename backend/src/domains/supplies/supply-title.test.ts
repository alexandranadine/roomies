import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidSupplyTitleError } from './errors.js';
import {
  normalizeSupplyTitle,
  SUPPLY_TITLE_MAX_LENGTH,
} from './supply-title.js';

void describe('normalizeSupplyTitle', () => {
  void it('trims surrounding whitespace and preserves internal Unicode text', () => {
    assert.equal(normalizeSupplyTitle('  Paper towels  '), 'Paper towels');
    assert.equal(normalizeSupplyTitle('  Café 家  '), 'Café 家');
    assert.equal(normalizeSupplyTitle('Paper  towels'), 'Paper  towels');
  });

  void it('rejects empty and whitespace-only titles without truncating', () => {
    assert.throws(() => normalizeSupplyTitle(''), InvalidSupplyTitleError);
    assert.throws(() => normalizeSupplyTitle('   '), InvalidSupplyTitleError);
    assert.throws(() => normalizeSupplyTitle('\n\t'), InvalidSupplyTitleError);
  });

  void it('rejects overlong titles without truncating', () => {
    const max = 'x'.repeat(SUPPLY_TITLE_MAX_LENGTH);
    const overlong = 'x'.repeat(SUPPLY_TITLE_MAX_LENGTH + 1);
    assert.equal(normalizeSupplyTitle(max), max);
    assert.throws(
      () => normalizeSupplyTitle(overlong),
      InvalidSupplyTitleError,
    );
    assert.equal(overlong.length, SUPPLY_TITLE_MAX_LENGTH + 1);
    assert.equal(SUPPLY_TITLE_MAX_LENGTH, 120);
  });
});
