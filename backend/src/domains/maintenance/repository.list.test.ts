import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL } from './repository.js';

void describe('visible Maintenance list SQL', () => {
  void it('combines actor scope, visibility, status, keyset, order, and limit', () => {
    assert.match(LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL, /WITH actor_scope AS/);
    assert.match(LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL, /visible_entries AS/);
    assert.match(
      LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL,
      /\$3::text IS NULL OR e\.status = \$3/,
    );
    assert.match(LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL, /\$6::uuid IS NULL/);
    assert.match(LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL, /LIMIT \$7/);
    assert.match(
      LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL,
      /FROM actor_scope\s+LEFT JOIN visible_entries ON TRUE/,
    );
    assert.doesNotMatch(LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL, /OFFSET/);
    assert.doesNotMatch(LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL, /COUNT\(\*\)/);
    assert.doesNotMatch(LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL, /e\.details/);
  });

  void it('orders by statusRank ASC, updatedAt DESC, id DESC', () => {
    assert.match(
      LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL,
      /CASE e\.status WHEN 'OPEN' THEN 0 WHEN 'RESOLVED' THEN 1 END\s+ASC/,
    );
    assert.match(
      LIST_VISIBLE_MAINTENANCE_ENTRIES_SQL,
      /e\.updated_at DESC,\s+e\.id DESC/,
    );
  });
});
