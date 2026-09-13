import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidTaskTitleError } from './errors.js';
import { normalizeTaskTitle } from './task-title.js';

void describe('normalizeTaskTitle', () => {
  void it('trims surrounding whitespace and preserves internal Unicode text', () => {
    assert.equal(normalizeTaskTitle('  Take out trash  '), 'Take out trash');
    assert.equal(normalizeTaskTitle('  Café 家  '), 'Café 家');
    assert.equal(normalizeTaskTitle('Take  out  trash'), 'Take  out  trash');
  });

  void it('rejects empty and whitespace-only titles without truncating', () => {
    assert.throws(() => normalizeTaskTitle(''), InvalidTaskTitleError);
    assert.throws(() => normalizeTaskTitle('   '), InvalidTaskTitleError);
    assert.throws(() => normalizeTaskTitle('\n\t'), InvalidTaskTitleError);
    const long = 'x'.repeat(10_000);
    assert.equal(normalizeTaskTitle(long), long);
  });
});
