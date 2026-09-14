import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAIM_OUTBOX_EVENT_SQL,
  HANDLER_SAVEPOINT,
  MARK_OUTBOX_EVENT_PROCESSED_SQL,
  RECORD_OUTBOX_EVENT_FAILURE_SQL,
} from './consumer.js';

void describe('outbox consumer SQL', () => {
  void it('claims with SKIP LOCKED, oldest-eligible order, and subscribed types only', () => {
    assert.match(CLAIM_OUTBOX_EVENT_SQL, /FOR UPDATE SKIP LOCKED/);
    assert.match(
      CLAIM_OUTBOX_EVENT_SQL,
      /ORDER BY available_at ASC, created_at ASC, event_id ASC/,
    );
    assert.match(CLAIM_OUTBOX_EVENT_SQL, /processed_at IS NULL/);
    assert.match(CLAIM_OUTBOX_EVENT_SQL, /dead_at IS NULL/);
    assert.match(CLAIM_OUTBOX_EVENT_SQL, /available_at <= \$1::timestamptz/);
    assert.match(
      CLAIM_OUTBOX_EVENT_SQL,
      /lease_until IS NULL OR lease_until <= \$1::timestamptz/,
    );
    assert.match(CLAIM_OUTBOX_EVENT_SQL, /event_type = ANY\(\$2::text\[\]\)/);
    assert.match(CLAIM_OUTBOX_EVENT_SQL, /LIMIT 1/);
    assert.doesNotMatch(CLAIM_OUTBOX_EVENT_SQL, /SERIALIZABLE/);
    assert.doesNotMatch(CLAIM_OUTBOX_EVENT_SQL, /pg_advisory/i);
  });

  void it('marks processed and records failure without touching payload', () => {
    assert.match(
      MARK_OUTBOX_EVENT_PROCESSED_SQL,
      /processed_at = \$2::timestamptz/,
    );
    assert.match(MARK_OUTBOX_EVENT_PROCESSED_SQL, /lease_owner = NULL/);
    assert.match(
      RECORD_OUTBOX_EVENT_FAILURE_SQL,
      /attempt_count = attempt_count \+ 1/,
    );
    assert.match(
      RECORD_OUTBOX_EVENT_FAILURE_SQL,
      /last_error_code = \$3::varchar/,
    );
    assert.match(RECORD_OUTBOX_EVENT_FAILURE_SQL, /dead_at = \$5::timestamptz/);
    assert.doesNotMatch(MARK_OUTBOX_EVENT_PROCESSED_SQL, /payload/);
    assert.doesNotMatch(RECORD_OUTBOX_EVENT_FAILURE_SQL, /payload/);
    assert.equal(HANDLER_SAVEPOINT, 'outbox_event_handler');
  });
});
