import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOME_NAME_MAX_LENGTH,
  InvalidHomeNameError,
  normalizeHomeName,
} from './home-name.js';

void describe('normalizeHomeName', () => {
  void it('trims surrounding whitespace and preserves internal Unicode text', () => {
    assert.equal(normalizeHomeName('  Oak Street  '), 'Oak Street');
    assert.equal(normalizeHomeName('  Café 家  '), 'Café 家');
    assert.equal(normalizeHomeName('Oak  Street'), 'Oak  Street');
  });

  void it('rejects empty-after-trim without truncating long names', () => {
    assert.throws(() => normalizeHomeName(''), InvalidHomeNameError);
    assert.throws(() => normalizeHomeName('   '), InvalidHomeNameError);
    assert.throws(
      () => normalizeHomeName('x'.repeat(HOME_NAME_MAX_LENGTH + 1)),
      InvalidHomeNameError,
    );
    assert.equal(
      normalizeHomeName('x'.repeat(HOME_NAME_MAX_LENGTH)),
      'x'.repeat(HOME_NAME_MAX_LENGTH),
    );
  });
});
