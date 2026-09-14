import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DuplicateOutboxHandlerRegistrationError,
  InvalidOutboxHandlerRegistrationError,
} from './errors.js';
import type { OutboxEventHandler } from './handler.js';
import { createOutboxHandlerRegistry } from './registry.js';

const PROJECTION_V1 = 'test.projection.v1';
const PROJECTION_V2 = 'test.projection.v2';
const OTHER_V1 = 'test.other.v1';

function silentHandler(
  handlerId: string,
  eventTypes: readonly string[],
): OutboxEventHandler {
  return Object.freeze({
    handlerId,
    eventTypes,
    handle: () => Promise.resolve(),
  });
}

void describe('createOutboxHandlerRegistry', () => {
  void it('dispatches only the exact versioned event type', () => {
    const projection = silentHandler('alpha', [PROJECTION_V1]);
    const other = silentHandler('beta', [OTHER_V1]);
    const registry = createOutboxHandlerRegistry([projection, other]);

    assert.deepEqual(registry.handlersFor(PROJECTION_V1), [projection]);
    assert.deepEqual(registry.handlersFor(OTHER_V1), [other]);
    assert.deepEqual(registry.handlersFor(PROJECTION_V2), []);
    assert.deepEqual(registry.handlersFor('test.projection.v10'), []);
    assert.deepEqual(registry.handlersFor('test.projection'), []);
    assert.deepEqual(registry.handlersFor('TEST.projection.v1'), []);
  });

  void it('allows two different handler identities on the same event type', () => {
    const alpha = silentHandler('alpha', [PROJECTION_V1]);
    const beta = silentHandler('beta', [PROJECTION_V1]);
    const registry = createOutboxHandlerRegistry([alpha, beta]);
    assert.deepEqual(registry.handlersFor(PROJECTION_V1), [alpha, beta]);
  });

  void it('rejects duplicate registration of the same handlerId and event type', () => {
    const first = silentHandler('alpha', [PROJECTION_V1]);
    const second = silentHandler('alpha', [PROJECTION_V1]);
    assert.throws(
      () => createOutboxHandlerRegistry([first, second]),
      (error: unknown) => {
        assert.ok(error instanceof DuplicateOutboxHandlerRegistrationError);
        assert.equal(error.handlerId, 'alpha');
        assert.equal(error.eventType, PROJECTION_V1);
        assert.equal(error.message, 'Duplicate outbox handler registration');
        assert.equal(error.message.includes('{'), false);
        return true;
      },
    );
  });

  void it('allows the same handlerId to register different event types', () => {
    const first = silentHandler('alpha', [PROJECTION_V1]);
    const second = silentHandler('alpha', [OTHER_V1]);
    const registry = createOutboxHandlerRegistry([first, second]);
    assert.deepEqual(registry.handlersFor(PROJECTION_V1), [first]);
    assert.deepEqual(registry.handlersFor(OTHER_V1), [second]);
  });

  void it('preserves explicit composition order for a shared event type', () => {
    const beta = silentHandler('beta', [PROJECTION_V1]);
    const alpha = silentHandler('alpha', [PROJECTION_V1]);
    const registry = createOutboxHandlerRegistry([beta, alpha]);
    assert.deepEqual(
      registry.handlersFor(PROJECTION_V1).map((handler) => handler.handlerId),
      ['beta', 'alpha'],
    );
  });

  void it('does not treat a version mismatch as a wildcard match', () => {
    const registry = createOutboxHandlerRegistry([
      silentHandler('alpha', [PROJECTION_V1]),
    ]);
    assert.deepEqual(registry.eventTypes, [PROJECTION_V1]);
    assert.deepEqual(registry.handlersFor(PROJECTION_V2), []);
  });

  void it('rejects empty, duplicate-within-handler, and invalid type strings', () => {
    assert.throws(
      () => createOutboxHandlerRegistry([silentHandler('alpha', [])]),
      InvalidOutboxHandlerRegistrationError,
    );
    assert.throws(
      () =>
        createOutboxHandlerRegistry([
          silentHandler('alpha', [PROJECTION_V1, PROJECTION_V1]),
        ]),
      InvalidOutboxHandlerRegistrationError,
    );
    assert.throws(
      () =>
        createOutboxHandlerRegistry([
          silentHandler('alpha', ['Maintenance.Created.V1']),
        ]),
      InvalidOutboxHandlerRegistrationError,
    );
    assert.throws(
      () =>
        createOutboxHandlerRegistry([
          silentHandler('alpha', ['test.projection.*']),
        ]),
      InvalidOutboxHandlerRegistrationError,
    );
    assert.throws(
      () => createOutboxHandlerRegistry([silentHandler('', [PROJECTION_V1])]),
      InvalidOutboxHandlerRegistrationError,
    );
    assert.throws(
      () =>
        createOutboxHandlerRegistry([silentHandler('Alpha', [PROJECTION_V1])]),
      InvalidOutboxHandlerRegistrationError,
    );
  });
});
